'use strict';

/**
 * src/modules/career-health/chiSnapshot.repository.js
 *
 * Wave 3 Priority #4.2.1
 * Partition-compatible CHI repository for public.chi_scores
 *
 * Guarantees:
 * - fully compatible with appEntryroute.js
 * - optimized for RANGE partition pruning
 * - append-safe snapshot history writes
 * - no invalid partition upserts
 * - safe latest-read fast path
 */

const { supabase } = require('../../config/supabase');
const logger = require('../../utils/logger');

const TABLE = 'chi_scores';

class ChiSnapshotRepository {
  normalizeWritePayload(snapshot = {}) {
    const id =
      snapshot.id ??
      snapshot.snapshotId ??
      snapshot.snapshot_id ??
      `${snapshot.userId || snapshot.user_id}-${Date.now()}`;

    const userId = snapshot.userId ?? snapshot.user_id;
    const roleId =
      snapshot.roleId ??
      snapshot.role_id ??
      snapshot.analysisSource ??
      snapshot.analysis_source ??
      'default';

    if (!id || !userId) {
      throw new Error(
        '[ChiSnapshotRepository] id and userId are required'
      );
    }

    return {
      id,
      user_id: userId,
      role_id: roleId,
      skill_match: Number(snapshot.skill_match ?? snapshot.skillMatch ?? 0),
      experience_fit: Number(
        snapshot.experience_fit ?? snapshot.experienceFit ?? 0
      ),
      market_demand: Number(
        snapshot.market_demand ?? snapshot.marketDemand ?? 0
      ),
      learning_progress: Number(
        snapshot.learning_progress ??
          snapshot.learningProgress ??
          0
      ),
      chi_score: Number(
        snapshot.chi_score ?? snapshot.chiScore ?? 0
      ),
      last_updated: new Date().toISOString(),
    };
  }

  /**
   * Append-only CHI snapshot write
   * Safe for partitioned PK (id, last_updated)
   */
  async writeSnapshot(snapshot) {
    const row = this.normalizeWritePayload(snapshot);

    try {
      const { data, error } = await supabase
        .from(TABLE)
        .insert(row)
        .select()
        .single();

      if (error) throw error;

      logger.debug('[ChiSnapshotRepository] Snapshot persisted', {
        userId: row.user_id,
        id: row.id,
      });

      return data?.id || row.id;
    } catch (error) {
      logger.error('[ChiSnapshotRepository] Snapshot write failed', {
        userId: row.user_id,
        id: row.id,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Latest CHI snapshot by user
   * Optimized for partition pruning + DESC index
   */
  async getLatest(userId, options = {}) {
    try {
      let query = supabase
        .from(TABLE)
        .select('*')
        .eq('user_id', userId)
        .order('last_updated', { ascending: false })
        .limit(1);

      if (options.roleId) {
        query = query.eq('role_id', options.roleId);
      }

      const { data, error } = await query.maybeSingle();

      if (error) throw error;

      return data || null;
    } catch (error) {
      logger.warn('[ChiSnapshotRepository] Latest lookup failed', {
        userId,
        error: error.message,
      });
      return null;
    }
  }

  /**
   * Historical CHI trend
   * Cursor = last_updated timestamp
   */
  async getHistory(userId, { limit = 20, before } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);

    try {
      let query = supabase
        .from(TABLE)
        .select('*')
        .eq('user_id', userId)
        .order('last_updated', { ascending: false })
        .limit(safeLimit);

      if (before) {
        query = query.lt('last_updated', before);
      }

      const { data, error } = await query;

      if (error) throw error;

      return {
        snapshots: data || [],
        nextCursor:
          data?.length === safeLimit
            ? data[data.length - 1].last_updated
            : null,
      };
    } catch (error) {
      logger.warn('[ChiSnapshotRepository] History lookup failed', {
        userId,
        error: error.message,
      });

      return {
        snapshots: [],
        nextCursor: null,
      };
    }
  }

  /**
   * No-op soft delete compatibility
   * chi_scores is append-only history
   */
  async softDelete(userId, snapshotId) {
    logger.info(
      '[ChiSnapshotRepository] softDelete skipped for append-only chi_scores',
      { userId, snapshotId }
    );

    return true;
  }
}

module.exports = new ChiSnapshotRepository();