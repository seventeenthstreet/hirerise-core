'use strict';

/**
 * job.repository.js  (v3 — hardened)
 *
 * Improvements:
 * - Sanitizes jobCode before using as document ID
 * - Defensive guard against invalid IDs
 * - Removes per-record debug logging (reduces log noise)
 * - Simplified existence check (no unnecessary data reads)
 */

const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const logger = require('../../../../shared/logger');

class JobRepository {
  constructor() {
    this._db  = getFirestore();
    this._col = 'jobs';
  }

  _ref() {
    return this._db.collection(this._col);
  }

  /**
   * Normalize and sanitize jobCode for safe Firestore doc ID.
   * - Trim whitespace
   * - Convert to uppercase (optional but recommended for consistency)
   * - Remove forward slashes
   */
  _normalizeJobCode(jobCode) {
    if (!jobCode || typeof jobCode !== 'string') {
      throw new Error('Invalid jobCode provided to repository');
    }

    return jobCode
      .trim()
      .toUpperCase()
      .replace(/\//g, '_');
  }

  _docRef(jobCode) {
    const normalized = this._normalizeJobCode(jobCode);
    return this._ref().doc(normalized);
  }

  // ---------------------------------------------------------------------------
  // Batch API
  // ---------------------------------------------------------------------------

  createBatch() {
    return this._db.batch();
  }

  addUpsertToBatch(batch, jobData, isNew) {
    const normalizedCode = this._normalizeJobCode(jobData.jobCode);
    const ref            = this._ref().doc(normalizedCode);
    const now            = FieldValue.serverTimestamp();

    const payload = {
      ...jobData,
      jobCode: normalizedCode, // ensure stored value matches doc ID
      isDeleted: false,
      updatedAt: now,
      ...(isNew ? { createdAt: now } : {}),
    };

    batch.set(ref, payload, { merge: true });
  }

  async commitBatch(batch) {
    try {
      await batch.commit();
    } catch (err) {
      logger.error('[JobRepository.commitBatch] failed', { error: err.message });
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Existence check
  // ---------------------------------------------------------------------------

  async exists(jobCode) {
    try {
      const snap = await this._docRef(jobCode).get();
      return snap.exists; // we don't care about isDeleted for sync
    } catch (err) {
      logger.error('[JobRepository.exists]', { jobCode, error: err.message });
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Read API
  // ---------------------------------------------------------------------------

  async findByJobCode(jobCode) {
    try {
      const snap = await this._docRef(jobCode).get();
      if (!snap.exists) return null;
      return { id: snap.id, ...snap.data() };
    } catch (err) {
      logger.error('[JobRepository.findByJobCode]', { jobCode, error: err.message });
      throw err;
    }
  }
}

module.exports = new JobRepository();