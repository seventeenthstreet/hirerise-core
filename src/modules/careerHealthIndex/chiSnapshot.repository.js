'use strict';

/**
 * chiSnapshot.repository.js
 *
 * FIXED: Converted from Firestore to native Supabase.
 *
 * Removed:
 *   - db.batch() / batch.set() / batch.update() / batch.commit()
 *   - this._subcollectionRef() — subcollection pattern has no Supabase equivalent
 *   - this._indexRef().doc() / this._legacyRef().doc()
 *   - .where() / .orderBy() / .limit() Firestore chaining
 *   - snap.exists / snap.empty / snap.docs / snap.docs[0].data()
 *   - FieldValue.serverTimestamp() / FieldValue.increment()
 *   - Timestamp.fromDate()
 *   - db.runTransaction()
 *
 * Replaced with:
 *   - supabase.from('chi_snapshots') / 'chi_snapshots_index' / 'career_health_index'
 *   - { data, error } destructuring on every query
 *   - Promise.all([]) for parallel multi-table writes (replaces batch)
 *   - supabase .upsert() for all writes
 *   - .eq() / .order() / .limit() / .maybeSingle() Supabase API
 *   - ISO strings for all timestamps
 *   - Keyset pagination (generated_at) replaces Firestore cursor docs
 */

const supabase = require('../../config/supabase');
const logger   = require('../../utils/logger');

const SNAPSHOT_RETENTION_DAYS = parseInt(process.env.CHI_SNAPSHOT_RETENTION_DAYS || '730', 10);

// Lightweight index fields (snake_case — Postgres columns)
const INDEX_FIELDS = [
  'snapshot_id', 'user_id', 'chi_score', 'analysis_source',
  'generated_at', 'ai_model_version', 'region', 'soft_deleted', 'expires_at',
];

class ChiSnapshotRepository {

  // ─── TTL helper ────────────────────────────────────────────────────────────

  // FIXED: replaced Timestamp.fromDate() with ISO string
  _expiresAt() {
    const d = new Date();
    d.setDate(d.getDate() + SNAPSHOT_RETENTION_DAYS);
    return d.toISOString();
  }

  // ─── Write ─────────────────────────────────────────────────────────────────

  /**
   * writeSnapshot(snapshot)
   *
   * FIXED: replaced db.batch() + batch.set() + batch.commit() with Promise.all upserts.
   * Writes to chi_snapshots (primary), chi_snapshots_index (admin), and
   * career_health_index (legacy backward-compat).
   *
   * @param {Object} snapshot
   * @returns {Promise<string>} snapshotId
   */
  async writeSnapshot(snapshot) {
    const { snapshotId, userId } = snapshot;
    if (!snapshotId || !userId) {
      throw new Error('[ChiSnapshotRepo] snapshot must have snapshotId and userId');
    }

    const expiresAt = this._expiresAt();
    const enriched  = { ...snapshot, expires_at: expiresAt, _v: 2 };

    // Build lightweight index payload (snake_case subset only)
    const indexDoc = { expires_at: expiresAt };
    INDEX_FIELDS.forEach(f => {
      // Accept both camelCase (app layer) and snake_case (DB) field names on input
      const camel = f.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      if (enriched[camel] !== undefined)  indexDoc[f] = enriched[camel];
      else if (enriched[f] !== undefined) indexDoc[f] = enriched[f];
    });

    try {
      // FIXED: replaced batch.set(subcollectionRef.doc(), ...) with Promise.all upserts
      const [r1, r2, r3] = await Promise.all([
        // 1. Primary snapshot table (replaces per-user subcollection)
        supabase
          .from('chi_snapshots')
          .upsert([{ ...enriched, id: snapshotId, user_id: userId }], { onConflict: 'id' }),

        // 2. Lightweight index (admin/aggregate queries)
        supabase
          .from('chi_snapshots_index')
          .upsert([{ ...indexDoc, id: snapshotId }], { onConflict: 'id' }),

        // 3. Legacy flat table (backward compat — remove after migration window)
        supabase
          .from('career_health_index')
          .upsert([{ ...enriched, id: snapshotId, user_id: userId }], { onConflict: 'id' }),
      ]);

      for (const { error } of [r1, r2, r3]) {
        if (error) throw error;
      }

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
   * FIXED: replaced .where() / .orderBy() Firestore chaining and snap.empty /
   * snap.docs[0].data() with Supabase .eq() / .order() / .maybeSingle().
   *
   * Fast path: chi_snapshots.
   * Fallback: career_health_index (legacy users pre-migration).
   *
   * @param {string} userId
   * @param {{ analysisSource?: string }} [opts]
   * @returns {Promise<Object|null>}
   */
  async getLatest(userId, { analysisSource } = {}) {
    // ── Fast path: chi_snapshots ──────────────────────────────────────────
    try {
      let query = supabase
        .from('chi_snapshots')
        .select('*')
        .eq('user_id', userId)
        .eq('soft_deleted', false)
        .order('generated_at', { ascending: false })
        .limit(1);

      if (analysisSource) query = query.eq('analysis_source', analysisSource);

      const { data, error } = await query.maybeSingle();
      if (error) throw error;
      if (data) return data;
    } catch (err) {
      logger.warn('[ChiSnapshotRepo] chi_snapshots getLatest failed, trying legacy', {
        userId, error: err.message,
      });
    }

    // ── Fallback: career_health_index ─────────────────────────────────────
    try {
      let query = supabase
        .from('career_health_index')
        .select('*')
        .eq('user_id', userId)
        .eq('soft_deleted', false)
        .order('generated_at', { ascending: false })
        .limit(1);

      if (analysisSource) query = query.eq('analysis_source', analysisSource);

      const { data, error } = await query.maybeSingle();
      if (error) throw error;
      return data ?? null;
    } catch (err) {
      logger.error('[ChiSnapshotRepo] Legacy getLatest also failed', { userId, error: err.message });
    }

    return null;
  }

  // ─── Read: history ─────────────────────────────────────────────────────────

  /**
   * getHistory(userId, { limit?, cursor? })
   *
   * FIXED: replaced Firestore .where() / .orderBy() chaining, snap.empty,
   * snap.docs.map(d => d.data()), and subcollectionRef cursor doc lookup
   * with Supabase keyset pagination on generated_at.
   *
   * @param {string} userId
   * @param {{ limit?: number, cursor?: string }} [opts]
   * @returns {Promise<{ snapshots: Object[], nextCursor: string|null }>}
   */
  async getHistory(userId, { limit = 20, cursor } = {}) {
    const safeLimit = Math.min(limit, 100);

    // ── Fast path: chi_snapshots ──────────────────────────────────────────
    try {
      let query = supabase
        .from('chi_snapshots')
        .select('*')
        .eq('user_id', userId)
        .eq('soft_deleted', false)
        .order('generated_at', { ascending: false })
        .limit(safeLimit + 1); // +1 to detect next page

      // FIXED: replaced subcollectionRef(userId).doc(cursor).get() + cursorDoc.exists
      // with a keyset lookup on generated_at
      if (cursor) {
        const { data: cursorRow } = await supabase
          .from('chi_snapshots')
          .select('generated_at')
          .eq('id', cursor)
          .maybeSingle();

        if (cursorRow) {
          query = query.lt('generated_at', cursorRow.generated_at);
        }
      }

      const { data, error } = await query;
      if (error) throw error;

      if (data && (data.length > 0 || cursor)) {
        const rows    = data.slice(0, safeLimit);
        const hasMore = data.length > safeLimit;
        return {
          snapshots:  rows,
          nextCursor: hasMore ? rows[rows.length - 1].id : null,
        };
      }
    } catch (err) {
      logger.warn('[ChiSnapshotRepo] chi_snapshots getHistory failed, trying legacy', {
        userId, error: err.message,
      });
    }

    // ── Fallback: career_health_index ─────────────────────────────────────
    try {
      const { data, error } = await supabase
        .from('career_health_index')
        .select('*')
        .eq('user_id', userId)
        .eq('soft_deleted', false)
        .order('generated_at', { ascending: false })
        .limit(safeLimit);

      if (error) throw error;

      return { snapshots: data ?? [], nextCursor: null };
    } catch (err) {
      logger.error('[ChiSnapshotRepo] Legacy getHistory also failed', { userId, error: err.message });
      return { snapshots: [], nextCursor: null };
    }
  }

  // ─── Admin: cross-user index reads ────────────────────────────────────────

  /**
   * getRecentIndexEntries({ limit?, since? })
   *
   * FIXED: replaced .where() / .orderBy() Firestore chaining, Timestamp.fromDate(),
   * snap.docs.map(d => d.data()) with Supabase equivalents.
   *
   * @param {{ limit?: number, since?: Date }} [opts]
   * @returns {Promise<Object[]>}
   */
  async getRecentIndexEntries({ limit = 500, since } = {}) {
    let query = supabase
      .from('chi_snapshots_index')
      .select('*')
      .eq('soft_deleted', false)
      .order('generated_at', { ascending: false })
      .limit(limit);

    // FIXED: replaced Timestamp.fromDate(since) with ISO string
    if (since) query = query.gte('generated_at', since.toISOString());

    const { data, error } = await query;

    if (error) {
      logger.error('[ChiSnapshotRepo] getRecentIndexEntries failed', { error: error.message });
      throw error;
    }

    return data ?? [];
  }

  // ─── Soft delete ───────────────────────────────────────────────────────────

  /**
   * softDelete(userId, snapshotId)
   *
   * FIXED: replaced db.batch() + batch.update() + batch.commit() and
   * FieldValue.serverTimestamp() with Promise.all of supabase .update() calls.
   */
  async softDelete(userId, snapshotId) {
    // FIXED: replaced FieldValue.serverTimestamp() with ISO string
    const update = {
      soft_deleted: true,
      deleted_at:   new Date().toISOString(),
    };

    // FIXED: replaced batch.update(subcollectionRef.doc(), ...) with Promise.all updates
    const [r1, r2, r3] = await Promise.all([
      supabase
        .from('chi_snapshots')
        .update(update)
        .eq('id', snapshotId)
        .eq('user_id', userId),

      supabase
        .from('chi_snapshots_index')
        .update(update)
        .eq('id', snapshotId),

      supabase
        .from('career_health_index')
        .update(update)
        .eq('id', snapshotId),
    ]);

    for (const { error } of [r1, r2, r3]) {
      if (error) {
        logger.error('[ChiSnapshotRepo] softDelete partial failure', {
          snapshotId,
          error: error.message,
        });
      }
    }

    logger.info('[ChiSnapshotRepo] Soft deleted snapshot', { userId, snapshotId });
  }
}

module.exports = new ChiSnapshotRepository();