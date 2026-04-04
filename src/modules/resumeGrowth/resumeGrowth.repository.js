'use strict';

/**
 * src/modules/resumeGrowth/resumeGrowth.repository.js
 *
 * Production-ready Supabase repository
 * -----------------------------------
 * Stores immutable resume growth signal snapshots.
 *
 * Optimizations:
 * - explicit column projection
 * - lean insert path
 * - DB-side timestamps
 * - safer error normalization
 * - pagination-ready history
 * - null-safe returns
 * - scalable latest lookup
 */

const { supabase } = require('../../config/supabase');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

const TABLE = 'resume_growth_signals';

const SIGNAL_COLUMNS = Object.freeze([
  'id',
  'user_id',
  'role_id',
  'signal',
  'created_at',
].join(','));

class ResumeGrowthRepository {
  /**
   * Persist immutable growth signal snapshot.
   * Append-only audit-safe storage.
   */
  async save(userId, roleId, signal) {
    const payload = {
      user_id: userId,
      role_id: roleId,
      signal,
      // created_at should ideally be DB default NOW()
    };

    const { data, error } = await supabase
      .from(TABLE)
      .insert(payload)
      .select('id')
      .single();

    if (error) {
      throw new AppError(
        'Failed to persist growth signal',
        500,
        {
          repository: 'ResumeGrowthRepository',
          operation: 'save',
          reason: error.message,
        },
        ErrorCodes.DATABASE_ERROR || 'DATABASE_ERROR'
      );
    }

    return data?.id || null;
  }

  /**
   * Fetch latest snapshot for user + role.
   * Hot read path optimized for composite index.
   */
  async getLatest(userId, roleId) {
    const { data, error } = await supabase
      .from(TABLE)
      .select(SIGNAL_COLUMNS)
      .eq('user_id', userId)
      .eq('role_id', roleId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new AppError(
        'Failed to fetch latest growth signal',
        500,
        {
          repository: 'ResumeGrowthRepository',
          operation: 'getLatest',
          reason: error.message,
        },
        ErrorCodes.DATABASE_ERROR || 'DATABASE_ERROR'
      );
    }

    return data || null;
  }

  /**
   * Fetch full signal history.
   * Supports optional pagination for future dashboard scaling.
   */
  async getHistory(userId, roleId, options = {}) {
    const limit = Number.isFinite(options.limit) ? options.limit : 100;
    const offset = Number.isFinite(options.offset) ? options.offset : 0;

    const { data, error } = await supabase
      .from(TABLE)
      .select(SIGNAL_COLUMNS)
      .eq('user_id', userId)
      .eq('role_id', roleId)
      .order('created_at', { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) {
      throw new AppError(
        'Failed to fetch growth signal history',
        500,
        {
          repository: 'ResumeGrowthRepository',
          operation: 'getHistory',
          reason: error.message,
        },
        ErrorCodes.DATABASE_ERROR || 'DATABASE_ERROR'
      );
    }

    return data || [];
  }
}

module.exports = ResumeGrowthRepository;