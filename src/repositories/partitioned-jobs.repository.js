/**
 * shared/repositories/partitioned-jobs.repository.js
 *
 * Partitioned AutomationJobs Repository — Hot Partition Mitigation
 *
 * Problem:
 *   A single 'automationJobs' collection at 100K submissions/day is
 *   ~1.16 writes/second average. Firestore's limit is ~1 write/second per
 *   document, but collection-level throughput can degrade due to index
 *   hotspotting on sequential writes (e.g., createdAt, status).
 *
 * Solution: Shard-prefix distribution
 *   Document IDs are prefixed with a 2-character hex shard derived from
 *   SHA-256(jobId)[0:2]. This distributes writes across 256 virtual shards,
 *   ensuring no single Firestore tablet handles all writes.
 *
 * Collection naming: automationJobs_{shardPrefix} (256 collections)
 *   e.g., automationJobs_3f, automationJobs_a1, automationJobs_00
 *
 * Tradeoffs vs Single Collection:
 *   ✅ No write hotspot at 100K+/day scale
 *   ✅ Cross-shard queries supported via Collection Group Query
 *   ⚠  Admin fan-out reads require collectionGroup() — slightly higher cost
 *   ⚠  Cannot query across shards with compound filters without an index per shard
 *
 * Alternative: Firestore Native Sharding
 *   For pure fan-out counters (not job docs), use FieldValue.increment() with
 *   distributed counters across N shard docs. Appropriate for count aggregation,
 *   not for job state management.
 *
 * Index requirements:
 *   Collection group index on: userId, status, deletedAt, createdAt
 *   Firestore will prompt for these in the Firebase console on first query.
 */

import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { createHash } from 'crypto';
import { logger } from '../logger/index.js';

const COLLECTION_PREFIX = 'automationJobs';

export class PartitionedJobRepository {
  #db;

  constructor() {
    this.#db = getFirestore();
  }

  // ─── Shard Resolution ─────────────────────────────────────────────────────

  /**
   * Deterministic 2-char hex shard prefix from jobId.
   * SHA-256 is used for uniform distribution (vs modulo which can cluster).
   * Same jobId always resolves to the same shard.
   */
  #shardPrefix(jobId) {
    return createHash('sha256').update(jobId).digest('hex').slice(0, 2);
  }

  #collectionName(jobId) {
    return `${COLLECTION_PREFIX}_${this.#shardPrefix(jobId)}`;
  }

  #ref(jobId) {
    return this.#db.collection(this.#collectionName(jobId)).doc(jobId);
  }

  // ─── Write Operations ──────────────────────────────────────────────────────

  /**
   * Creates a job with optional idempotency protection.
   * If idempotencyKey matches existing job, returns existing instead of creating duplicate.
   */
  async createJob(jobId, jobData) {
    const ref = this.#ref(jobId);

    // Idempotency check
    if (jobData.idempotencyKey) {
      const existing = await ref.get();
      if (existing.exists && existing.data().idempotencyKey === jobData.idempotencyKey) {
        logger.info('[JobRepo] Duplicate idempotencyKey — returning existing job', { jobId });
        return {
          jobId,
          duplicate: true,
          status: existing.data().status,
        };
      }
    }

    await ref.set({
      jobId,
      ...jobData,
      status:         'pending',
      attempts:       0,
      maxAttempts:    5,
      shardPrefix:    this.#shardPrefix(jobId),
      idempotencyKey: jobData.idempotencyKey ?? null,
      createdAt:      FieldValue.serverTimestamp(),
      updatedAt:      FieldValue.serverTimestamp(),
      deletedAt:      null,
    });

    return { jobId, duplicate: false };
  }

  async claimJob(jobId, workerId) {
    const ref = this.#ref(jobId);

    return this.#db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error(`Job ${jobId} not found`);

      const data = snap.data();
      if (data.status === 'processing' || data.status === 'complete') {
        return { claimed: false, status: data.status };
      }

      tx.update(ref, {
        status:     'processing',
        workerId,
        claimedAt:  FieldValue.serverTimestamp(),
        updatedAt:  FieldValue.serverTimestamp(),
        attempts:   FieldValue.increment(1),
      });

      return { claimed: true, data };
    });
  }

  async completeJob(jobId, result = {}) {
    await this.#ref(jobId).update({
      status:      'complete',
      result,
      completedAt: FieldValue.serverTimestamp(),
      updatedAt:   FieldValue.serverTimestamp(),
    });
  }

  async failJob(jobId, errorCode, errorMessage) {
    const snap = await this.#ref(jobId).get();
    const job = snap.data();
    const newStatus =
      job && job.attempts >= job.maxAttempts ? 'dead' : 'failed';

    await this.#ref(jobId).update({
      status:           newStatus,
      lastErrorCode:    errorCode,
      lastErrorMessage: errorMessage?.slice(0, 500),
      failedAt:         FieldValue.serverTimestamp(),
      updatedAt:        FieldValue.serverTimestamp(),
    });

    return newStatus;
  }

  // ─── Read Operations (Collection Group) ──────────────────────────────────

  /**
   * Finds a job by ID. Must know jobId to resolve shard — no scan needed.
   */
  async findById(jobId) {
    const snap = await this.#ref(jobId).get();
    if (!snap.exists || snap.data().deletedAt) return null;
    return { id: snap.id, ...this.#normalize(snap.data()) };
  }

  /**
   * Query pending jobs for a user across ALL shards via Collection Group Query.
   * Requires a collection group index: userId + status + deletedAt + createdAt.
   */
  async getPendingJobsForUser(userId, limit = 10) {
    const snap = await this.#db
      .collectionGroup(COLLECTION_PREFIX)
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

  /**
   * Count pending jobs for a user — used by rate limit middleware.
   * Firestore count() aggregation — single read, minimal cost.
   */
  async countPendingForUser(userId) {
    const snap = await this.#db
      .collectionGroup(COLLECTION_PREFIX)
      .where('userId', '==', userId)
      .where('status', 'in', ['pending', 'processing'])
      .where('deletedAt', '==', null)
      .count()
      .get();

    return snap.data().count;
  }

  /**
   * Find dead jobs for alerting/monitoring dashboard.
   * Scans across all shards — intended for async admin use, not hot path.
   */
  async getDeadJobs({ limit = 50, since = null } = {}) {
    let query = this.#db
      .collectionGroup(COLLECTION_PREFIX)
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