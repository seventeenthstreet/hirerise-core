/**
 * shared/repositories/partitioned-jobs.repository.js
 *
 * Firestore Sharded Automation Job Repository (Correct Collection Group Pattern)
 *
 * Collection Structure:
 *
 *   automationJobs/{shard}/jobs/{jobId}
 *
 * Example:
 *   automationJobs/3f/jobs/uuid-123
 *
 * Benefits:
 *   ✅ Eliminates write hotspotting
 *   ✅ Supports collectionGroup('jobs') queries
 *   ✅ Fully compatible with rate limit + admin queries
 *   ✅ No sequential index contention
 *
 * Required Indexes:
 *   collectionGroup: jobs
 *   Fields:
 *     - userId
 *     - status
 *     - deletedAt
 *     - createdAt (desc)
 */

import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { createHash } from 'crypto';
import { logger } from '../logger/index.js';

const ROOT_COLLECTION = 'automationJobs';
const SUB_COLLECTION  = 'jobs';
const SHARD_COUNT = 256; // 00–ff hex

export class PartitionedJobRepository {
  #db;

  constructor() {
    this.#db = getFirestore();
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Shard Resolution
  // ────────────────────────────────────────────────────────────────────────────

  #shardPrefix(jobId) {
    return createHash('sha256')
      .update(jobId)
      .digest('hex')
      .slice(0, 2); // 2 hex chars → 256 shards
  }

  #docRef(jobId) {
    const shard = this.#shardPrefix(jobId);
    return this.#db
      .collection(ROOT_COLLECTION)
      .doc(shard)
      .collection(SUB_COLLECTION)
      .doc(jobId);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Write Operations
  // ────────────────────────────────────────────────────────────────────────────

  async createJob(jobId, jobData) {
    const ref = this.#docRef(jobId);

    await ref.set({
      jobId,
      shard: this.#shardPrefix(jobId),
      ...jobData,
      status: 'pending',
      attempts: 0,
      maxAttempts: 5,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      deletedAt: null,
    });

    return jobId;
  }

  async claimJob(jobId, workerId) {
    const ref = this.#docRef(jobId);

    return this.#db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);

      if (!snap.exists) {
        throw new Error(`Job ${jobId} not found`);
      }

      const data = snap.data();

      if (data.status === 'processing' || data.status === 'complete') {
        return { claimed: false, status: data.status };
      }

      tx.update(ref, {
        status: 'processing',
        workerId,
        claimedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        attempts: FieldValue.increment(1),
      });

      return { claimed: true, data };
    });
  }

  async completeJob(jobId, result = {}) {
    await this.#docRef(jobId).update({
      status: 'complete',
      result,
      completedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  async failJob(jobId, errorCode, errorMessage) {
    const ref = this.#docRef(jobId);
    const snap = await ref.get();

    if (!snap.exists) {
      throw new Error(`Job ${jobId} not found`);
    }

    const data = snap.data();
    const newStatus =
      (data.attempts ?? 0) >= data.maxAttempts ? 'dead' : 'failed';

    await ref.update({
      status: newStatus,
      lastErrorCode: errorCode,
      lastErrorMessage: errorMessage?.slice(0, 500),
      failedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return newStatus;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Read Operations (Collection Group Queries)
  // ────────────────────────────────────────────────────────────────────────────

  async findById(jobId) {
    const snap = await this.#docRef(jobId).get();
    if (!snap.exists || snap.data().deletedAt) return null;
    return this.#normalize({ id: snap.id, ...snap.data() });
  }

  async getPendingJobsForUser(userId, limit = 10) {
    const snap = await this.#db
      .collectionGroup(SUB_COLLECTION)
      .where('userId', '==', userId)
      .where('status', 'in', ['pending', 'processing'])
      .where('deletedAt', '==', null)
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();

    return snap.docs.map((d) =>
      this.#normalize({ id: d.id, ...d.data() })
    );
  }

  async countPendingForUser(userId) {
    const snap = await this.#db
      .collectionGroup(SUB_COLLECTION)
      .where('userId', '==', userId)
      .where('status', 'in', ['pending', 'processing'])
      .where('deletedAt', '==', null)
      .count()
      .get();

    return snap.data().count;
  }

  async getDeadJobs({ limit = 50, since = null } = {}) {
    let query = this.#db
      .collectionGroup(SUB_COLLECTION)
      .where('status', '==', 'dead')
      .orderBy('failedAt', 'desc')
      .limit(limit);

    if (since) {
      query = query.where(
        'failedAt',
        '>=',
        Timestamp.fromDate(since)
      );
    }

    const snap = await query.get();

    return snap.docs.map((d) =>
      this.#normalize({ id: d.id, ...d.data() })
    );
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────────────────────

  #normalize(data) {
    const result = { ...data };
    for (const [k, v] of Object.entries(result)) {
      if (v instanceof Timestamp) {
        result[k] = v.toDate().toISOString();
      }
    }
    return result;
  }
}

export const partitionedJobRepo = new PartitionedJobRepository();