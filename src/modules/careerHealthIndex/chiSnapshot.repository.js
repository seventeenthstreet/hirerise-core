'use strict';

/**
 * chiSnapshotRepository.js
 *
 * CHI time-series sharding — Phase 4.
 *
 * PROBLEM WITH THE EXISTING FLAT COLLECTION:
 *   All CHI snapshots write to `careerHealthIndex/{snapshotId}`.
 *   Queries like "get latest for user X" require a composite index on
 *   (userId, generatedAt DESC) and scan the entire collection.
 *   At 10k users × 10 snapshots each = 100k documents in one collection.
 *   Firestore charges per-document-read, and admin trend queries fan out across all of them.
 *
 * SHARDING STRATEGY — two-layer layout:
 *
 *   Layer 1: Per-user subcollection (time-series reads)
 *     users/{userId}/chiSnapshots/{snapshotId}
 *     → Reads for a single user are scoped to their subcollection (no cross-user scan)
 *     → Ordered by generatedAt DESC — no composite index needed
 *     → History queries are O(user's own snapshots), not O(all users)
 *
 *   Layer 2: Flat fan-out index (admin/aggregate reads)
 *     chiSnapshots_index/{snapshotId}
 *     → Lightweight document: { userId, chiScore, analysisSource, generatedAt, snapshotId }
 *     → Enables admin dashboard queries across all users without reading full snapshots
 *     → TTL: same as retention policy (set Firestore TTL on expiresAt field)
 *
 * MIGRATION STRATEGY (backward compatible):
 *   - writeSnapshot() writes to BOTH the subcollection AND the flat index
 *   - getLatest() reads from subcollection first (fast path), falls back to legacy
 *     careerHealthIndex collection if subcollection is empty (supports existing users)
 *   - getHistory() same dual-read pattern
 *   - Old careerHealthIndex collection is NOT deleted — reads still work from it
 *   - Once all users have ≥1 snapshot in subcollection, the legacy reads become dead code
 *
 * EXISTING CODE CHANGES NEEDED:
 *   In careerHealthIndex.service.js, replace:
 *     await db.collection('careerHealthIndex').doc(snapshotId).set(snapshot);
 *   with:
 *     await chiSnapshotRepo.writeSnapshot(snapshot);
 *
 *   Replace fetchPreviousSnapshot():
 *     await chiSnapshotRepo.getLatest(userId);
 *
 *   Replace getChiHistory() query:
 *     await chiSnapshotRepo.getHistory(userId, { limit });
 *
 * @module modules/careerHealthIndex/chiSnapshot.repository
 */

const { db, FieldValue, Timestamp } = require('../../config/supabase');
const logger = require('../../utils/logger');

// Retention: 2 years for compliance (matches cost_tracking)
const SNAPSHOT_RETENTION_DAYS = parseInt(process.env.CHI_SNAPSHOT_RETENTION_DAYS || '730', 10);

// Index document fields — lightweight subset for cross-user admin queries
const INDEX_FIELDS = [
  'snapshotId', 'userId', 'chiScore', 'analysisSource',
  'generatedAt', 'aiModelVersion', 'region', 'softDeleted', 'expiresAt',
];

class ChiSnapshotRepository {
  constructor() {
    this._db = null;
  }

  get db() {
    if (!this._db) this._db = require('../../config/supabase').db;
    return this._db;
  }

  // ─── Subcollection ref helpers ─────────────────────────────────────────────

  _subcollectionRef(userId) {
    return this.db.collection('users').doc(userId).collection('chiSnapshots');
  }

  _indexRef() {
    return this.db.collection('chiSnapshots_index');
  }

  _legacyRef() {
    return this.db.collection('careerHealthIndex');
  }

  // ─── TTL helper ────────────────────────────────────────────────────────────

  _expiresAt() {
    const d = new Date();
    d.setDate(d.getDate() + SNAPSHOT_RETENTION_DAYS);
    return Timestamp.fromDate(d);
  }

  // ─── Write ─────────────────────────────────────────────────────────────────

  /**
   * writeSnapshot(snapshot)
   *
   * Dual-write: subcollection + index. Uses a batch for atomicity.
   * Also writes to legacy collection for backward compat during migration window.
   *
   * @param {Object} snapshot — full snapshot object from careerHealthIndex.service.js
   * @returns {Promise<string>} snapshotId
   */
  async writeSnapshot(snapshot) {
    const { snapshotId, userId } = snapshot;
    if (!snapshotId || !userId) {
      throw new Error('[ChiSnapshotRepo] snapshot must have snapshotId and userId');
    }

    const expiresAt = this._expiresAt();
    const enriched  = { ...snapshot, expiresAt, _v: 2 }; // _v:2 marks sharded writes

    const batch = this.db.batch();

    // 1. Per-user subcollection (primary store for user-facing reads)
    batch.set(
      this._subcollectionRef(userId).doc(snapshotId),
      enriched
    );

    // 2. Lightweight index document (admin/aggregate queries)
    const indexDoc = {};
    INDEX_FIELDS.forEach(f => {
      if (enriched[f] !== undefined) indexDoc[f] = enriched[f];
    });
    indexDoc.expiresAt = expiresAt;
    batch.set(
      this._indexRef().doc(snapshotId),
      indexDoc
    );

    // 3. Legacy flat collection (backward compat — remove after migration window)
    batch.set(
      this._legacyRef().doc(snapshotId),
      enriched
    );

    try {
      await batch.commit();
      logger.debug('[ChiSnapshotRepo] Wrote snapshot', { userId, snapshotId });
      return snapshotId;
    } catch (err) {
      logger.error('[ChiSnapshotRepo] Write failed', { userId, snapshotId, error: err.message });
      throw err;
    }
  }

  // ─── Read: latest ──────────────────────────────────────────────────────────

  /**
   * getLatest(userId, { analysisSource? } = {})
   *
   * Returns the most recent non-deleted snapshot for a user.
   * Fast path: subcollection (scoped, cheap).
   * Fallback: legacy flat collection (for users migrated before Phase 4).
   *
   * @param {string} userId
   * @param {Object} [opts]
   * @param {string} [opts.analysisSource] — filter by source ('full', 'provisional', etc.)
   * @returns {Promise<Object|null>}
   */
  async getLatest(userId, { analysisSource } = {}) {
    // ── Fast path: subcollection ───────────────────────────────────────────
    try {
      let q = this._subcollectionRef(userId)
        .where('softDeleted', '==', false)
        .orderBy('generatedAt', 'desc')
        .limit(1);

      if (analysisSource) q = q.where('analysisSource', '==', analysisSource);

      const snap = await q.get();
      if (!snap.empty) {
        return { id: snap.docs[0].id, ...snap.docs[0].data() };
      }
    } catch (err) {
      logger.warn('[ChiSnapshotRepo] Subcollection getLatest failed, trying legacy', {
        userId, error: err.message,
      });
    }

    // ── Fallback: legacy flat collection ──────────────────────────────────
    try {
      let q = this._legacyRef()
        .where('userId',      '==', userId)
        .where('softDeleted', '==', false)
        .orderBy('generatedAt', 'desc')
        .limit(1);

      if (analysisSource) q = q.where('analysisSource', '==', analysisSource);

      const snap = await q.get();
      if (!snap.empty) {
        return { id: snap.docs[0].id, ...snap.docs[0].data() };
      }
    } catch (err) {
      logger.error('[ChiSnapshotRepo] Legacy getLatest also failed', { userId, error: err.message });
    }

    return null;
  }

  // ─── Read: history ─────────────────────────────────────────────────────────

  /**
   * getHistory(userId, { limit?, cursor? })
   *
   * Returns paginated snapshot history ordered by generatedAt DESC.
   *
   * @param {string} userId
   * @param {Object} [opts]
   * @param {number} [opts.limit=20]
   * @param {string} [opts.cursor] — snapshotId of last seen document for pagination
   * @returns {Promise<{ snapshots: Object[], nextCursor: string|null }>}
   */
  async getHistory(userId, { limit = 20, cursor } = {}) {
    const safeLimit = Math.min(limit, 100);

    // ── Fast path: subcollection ───────────────────────────────────────────
    try {
      let q = this._subcollectionRef(userId)
        .where('softDeleted', '==', false)
        .orderBy('generatedAt', 'desc')
        .limit(safeLimit + 1); // fetch one extra to detect next page

      if (cursor) {
        const cursorDoc = await this._subcollectionRef(userId).doc(cursor).get();
        if (cursorDoc.exists) q = q.startAfter(cursorDoc);
      }

      const snap = await q.get();

      if (!snap.empty || cursor) {
        const docs    = snap.docs.slice(0, safeLimit).map(d => ({ id: d.id, ...d.data() }));
        const hasMore = snap.docs.length > safeLimit;
        return {
          snapshots:  docs,
          nextCursor: hasMore ? docs[docs.length - 1].snapshotId : null,
        };
      }
    } catch (err) {
      logger.warn('[ChiSnapshotRepo] Subcollection getHistory failed, trying legacy', {
        userId, error: err.message,
      });
    }

    // ── Fallback: legacy ──────────────────────────────────────────────────
    try {
      const snap = await this._legacyRef()
        .where('userId',      '==', userId)
        .where('softDeleted', '==', false)
        .orderBy('generatedAt', 'desc')
        .limit(safeLimit)
        .get();

      return {
        snapshots:  snap.docs.map(d => ({ id: d.id, ...d.data() })),
        nextCursor: null,
      };
    } catch (err) {
      logger.error('[ChiSnapshotRepo] Legacy getHistory also failed', { userId, error: err.message });
      return { snapshots: [], nextCursor: null };
    }
  }

  // ─── Admin: cross-user index reads ────────────────────────────────────────

  /**
   * getRecentIndexEntries({ limit?, since? })
   *
   * Admin-only: reads from the lightweight index for dashboard aggregation.
   * Does NOT read full snapshot documents.
   *
   * @param {Object} [opts]
   * @param {number} [opts.limit=500]
   * @param {Date}   [opts.since] — filter entries after this date
   */
  async getRecentIndexEntries({ limit = 500, since } = {}) {
    let q = this._indexRef()
      .where('softDeleted', '==', false)
      .orderBy('generatedAt', 'desc')
      .limit(limit);

    if (since) q = q.where('generatedAt', '>=', Timestamp.fromDate(since));

    const snap = await q.get();
    return snap.docs.map(d => d.data());
  }

  // ─── Soft delete ───────────────────────────────────────────────────────────

  /**
   * softDelete(userId, snapshotId)
   *
   * Marks a snapshot deleted in all three locations.
   */
  async softDelete(userId, snapshotId) {
    const update = { softDeleted: true, deletedAt: FieldValue.serverTimestamp() };
    const batch  = this.db.batch();

    batch.update(this._subcollectionRef(userId).doc(snapshotId), update);
    batch.update(this._indexRef().doc(snapshotId), update);
    batch.update(this._legacyRef().doc(snapshotId), update);

    await batch.commit();
    logger.info('[ChiSnapshotRepo] Soft deleted snapshot', { userId, snapshotId });
  }
}

module.exports = new ChiSnapshotRepository();









