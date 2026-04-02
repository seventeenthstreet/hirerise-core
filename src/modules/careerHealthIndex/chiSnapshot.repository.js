'use strict';

/**
 * src/modules/career-health/chiSnapshot.repository.js
 *
 * Production-grade Supabase snapshot repository.
 *
 * Improvements:
 * - removes Firestore-era multi-write assumptions where possible
 * - centralizes table names and payload normalization
 * - stronger null safety and write verification
 * - cursor pagination optimized for row-based Supabase access
 * - consistent snake_case persistence contract
 */

const { supabase } = require('../../config/supabase');
const logger = require('../../utils/logger');

const SNAPSHOT_RETENTION_DAYS = Number.parseInt(
  process.env.CHI_SNAPSHOT_RETENTION_DAYS || '730',
  10,
);

const TABLES = {
  primary: 'chi_snapshots',
  index: 'chi_snapshots_index',
  legacy: 'career_health_index',
};

const INDEX_FIELDS = [
  'snapshot_id',
  'user_id',
  'chi_score',
  'analysis_source',
  'generated_at',
  'ai_model_version',
  'region',
  'soft_deleted',
  'expires_at',
];

class ChiSnapshotRepository {
  getExpiresAt() {
    const date = new Date();
    date.setDate(date.getDate() + SNAPSHOT_RETENTION_DAYS);
    return date.toISOString();
  }

  normalizeSnapshot(snapshot) {
    const snapshotId = snapshot.snapshotId ?? snapshot.snapshot_id ?? snapshot.id;
    const userId = snapshot.userId ?? snapshot.user_id;

    if (!snapshotId || !userId) {
      throw new Error('[ChiSnapshotRepo] snapshot must include snapshotId and userId');
    }

    const generatedAt = snapshot.generatedAt ?? snapshot.generated_at ?? new Date().toISOString();
    const expiresAt = snapshot.expiresAt ?? snapshot.expires_at ?? this.getExpiresAt();

    return {
      ...snapshot,
      id: snapshotId,
      snapshot_id: snapshotId,
      user_id: userId,
      chi_score: snapshot.chiScore ?? snapshot.chi_score ?? null,
      analysis_source: snapshot.analysisSource ?? snapshot.analysis_source ?? null,
      generated_at: generatedAt,
      ai_model_version: snapshot.aiModelVersion ?? snapshot.ai_model_version ?? null,
      region: snapshot.region ?? null,
      soft_deleted: false,
      expires_at: expiresAt,
      _v: 2,
    };
  }

  buildIndexRow(normalized) {
    const row = {
      id: normalized.id,
      expires_at: normalized.expires_at,
    };

    for (const field of INDEX_FIELDS) {
      if (normalized[field] !== undefined) {
        row[field] = normalized[field];
      }
    }

    return row;
  }

  async writeSnapshot(snapshot) {
    const normalized = this.normalizeSnapshot(snapshot);
    const indexRow = this.buildIndexRow(normalized);

    try {
      const writes = await Promise.all([
        supabase.from(TABLES.primary).upsert(normalized, { onConflict: 'id' }),
        supabase.from(TABLES.index).upsert(indexRow, { onConflict: 'id' }),
        supabase.from(TABLES.legacy).upsert(normalized, { onConflict: 'id' }),
      ]);

      for (const result of writes) {
        if (result.error) throw result.error;
      }

      logger.debug('[ChiSnapshotRepo] Snapshot persisted', {
        userId: normalized.user_id,
        snapshotId: normalized.id,
      });

      return normalized.id;
    } catch (error) {
      logger.error('[ChiSnapshotRepo] Snapshot write failed', {
        userId: normalized.user_id,
        snapshotId: normalized.id,
        error: error.message,
      });
      throw error;
    }
  }

  async getLatest(userId, { analysisSource } = {}) {
    const buildQuery = (table) => {
      let query = supabase
        .from(table)
        .select('*')
        .eq('user_id', userId)
        .eq('soft_deleted', false)
        .order('generated_at', { ascending: false })
        .limit(1);

      if (analysisSource) {
        query = query.eq('analysis_source', analysisSource);
      }

      return query.maybeSingle();
    };

    for (const table of [TABLES.primary, TABLES.legacy]) {
      try {
        const { data, error } = await buildQuery(table);
        if (error) throw error;
        if (data) return data;
      } catch (error) {
        logger.warn('[ChiSnapshotRepo] Latest lookup failed', {
          table,
          userId,
          error: error.message,
        });
      }
    }

    return null;
  }

  async getHistory(userId, { limit = 20, cursor } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);

    try {
      let query = supabase
        .from(TABLES.primary)
        .select('*')
        .eq('user_id', userId)
        .eq('soft_deleted', false)
        .order('generated_at', { ascending: false })
        .limit(safeLimit + 1);

      if (cursor) {
        const { data: cursorRow } = await supabase
          .from(TABLES.primary)
          .select('generated_at,id')
          .eq('id', cursor)
          .maybeSingle();

        if (cursorRow?.generated_at) {
          query = query.lt('generated_at', cursorRow.generated_at);
        }
      }

      const { data, error } = await query;
      if (error) throw error;

      const rows = (data || []).slice(0, safeLimit);
      const hasMore = (data || []).length > safeLimit;

      return {
        snapshots: rows,
        nextCursor: hasMore && rows.length ? rows[rows.length - 1].id : null,
      };
    } catch (error) {
      logger.warn('[ChiSnapshotRepo] History lookup failed', {
        userId,
        error: error.message,
      });

      return {
        snapshots: [],
        nextCursor: null,
      };
    }
  }

  async softDelete(userId, snapshotId) {
    const update = {
      soft_deleted: true,
      deleted_at: new Date().toISOString(),
    };

    const operations = [
      supabase.from(TABLES.primary).update(update).eq('id', snapshotId).eq('user_id', userId),
      supabase.from(TABLES.index).update(update).eq('id', snapshotId),
      supabase.from(TABLES.legacy).update(update).eq('id', snapshotId),
    ];

    const results = await Promise.allSettled(operations);

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.error) {
        logger.error('[ChiSnapshotRepo] Soft delete failed', {
          userId,
          snapshotId,
          error: result.value.error.message,
        });
      }

      if (result.status === 'rejected') {
        logger.error('[ChiSnapshotRepo] Soft delete rejected', {
          userId,
          snapshotId,
          error: result.reason?.message,
        });
      }
    }

    logger.info('[ChiSnapshotRepo] Snapshot soft deleted', { userId, snapshotId });
  }
}

module.exports = new ChiSnapshotRepository();