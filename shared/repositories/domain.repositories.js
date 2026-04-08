'use strict';

/**
 * shared/repositories/domain.repository.js
 *
 * Resume + Score repositories
 * Fully production-hardened for Supabase
 *
 * ✅ Zero Firebase legacy
 * ✅ Safe transition verification
 * ✅ Timeout protected
 * ✅ Better score ID sanitization
 * ✅ Structured logging
 * ✅ Reusable query execution
 * ✅ Strong null safety
 * ✅ Better race-condition handling
 */

const { supabase } = require('../config/supabase');
const logger = require('../logger');

const DEFAULT_TIMEOUT_MS = 10000;

function nowISO() {
  return new Date().toISOString();
}

function sanitizeVersion(version) {
  return String(version).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function normalizeDbError(error, context = {}) {
  const err = new Error(error?.message || 'Database operation failed');
  err.code = error?.code || 'DB_ERROR';
  err.details = error?.details;
  err.context = context;
  return err;
}

// ─────────────────────────────────────────────
// Safe Execute Wrapper
// ─────────────────────────────────────────────
async function execute(query, context = {}) {
  let timeoutId;

  try {
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        const err = new Error('Database query timeout');
        err.code = 'DB_TIMEOUT';
        reject(err);
      }, DEFAULT_TIMEOUT_MS);
    });

    const result = await Promise.race([query, timeoutPromise]);
    clearTimeout(timeoutId);

    const { data, error } = result;

    if (error) {
      const normalized = normalizeDbError(error, context);

      logger.error('Supabase repository error', {
        ...context,
        code: normalized.code,
        message: normalized.message,
        details: normalized.details,
      });

      throw normalized;
    }

    return data;
  } catch (error) {
    clearTimeout(timeoutId);

    logger.error('Repository execution failure', {
      ...context,
      code: error.code,
      message: error.message,
    });

    throw error;
  }
}

// ─────────────────────────────────────────────
// Resume Repository
// ─────────────────────────────────────────────
class ResumeRepository {
  constructor() {
    this.table = 'resumes';
  }

  query() {
    return supabase.from(this.table);
  }

  async findByUserId(userId, limit = 10) {
    if (!userId) return [];

    const rows = await execute(
      this.query()
        .select('id, user_id, created_at, processing_status')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit),
      {
        method: 'findByUserId',
        userId,
      }
    );

    return rows ?? [];
  }

  async findLatestByUserId(userId) {
    if (!userId) return null;

    return execute(
      this.query()
        .select('*')
        .eq('user_id', userId)
        .eq('soft_deleted', false)
        .eq('is_primary', true)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      {
        method: 'findLatestByUserId',
        userId,
      }
    );
  }

  async markProcessing(resumeId) {
    if (!resumeId) return null;

    const timestamp = nowISO();

    return execute(
      this.query()
        .update({
          processing_status: 'processing',
          processing_started_at: timestamp,
          updated_at: timestamp,
        })
        .eq('id', resumeId)
        .in('processing_status', ['pending', 'failed'])
        .select('id, processing_status')
        .maybeSingle(),
      {
        method: 'markProcessing',
        resumeId,
      }
    );
  }

  async markComplete(resumeId, engineVersion) {
    if (!resumeId) return null;

    const timestamp = nowISO();

    return execute(
      this.query()
        .update({
          processing_status: 'complete',
          processed_at: timestamp,
          last_engine_version: engineVersion,
          updated_at: timestamp,
        })
        .eq('id', resumeId)
        .eq('processing_status', 'processing')
        .select('id, processing_status, processed_at')
        .maybeSingle(),
      {
        method: 'markComplete',
        resumeId,
      }
    );
  }

  async markFailed(resumeId, errorCode) {
    if (!resumeId) return null;

    const timestamp = nowISO();

    return execute(
      this.query()
        .update({
          processing_status: 'failed',
          failed_at: timestamp,
          last_error_code: errorCode,
          updated_at: timestamp,
        })
        .eq('id', resumeId)
        .neq('processing_status', 'complete')
        .select('id, processing_status, failed_at')
        .maybeSingle(),
      {
        method: 'markFailed',
        resumeId,
      }
    );
  }
}

// ─────────────────────────────────────────────
// Score Repository
// ─────────────────────────────────────────────
class ScoreRepository {
  constructor() {
    this.table = 'resume_scores';
  }

  query() {
    return supabase.from(this.table);
  }

  buildScoreId(userId, resumeId, engineVersion) {
    return `${userId}_${resumeId}_${sanitizeVersion(engineVersion)}`;
  }

  async upsertScore(userId, resumeId, engineVersion, scoreData = {}) {
    if (!userId || !resumeId || !engineVersion) {
      throw new Error('Missing required fields for scoring');
    }

    const timestamp = nowISO();
    const id = this.buildScoreId(userId, resumeId, engineVersion);

    const payload = {
      id,
      user_id: userId,
      resume_id: resumeId,
      engine_version: engineVersion,
      ...scoreData,
      scored_at: timestamp,
    };

    await execute(
      this.query().upsert(payload, {
        onConflict: 'id',
      }),
      {
        method: 'upsertScore',
        id,
      }
    );

    return id;
  }

  async getLatestScore(userId, resumeId) {
    if (!userId || !resumeId) return null;

    return execute(
      this.query()
        .select('*')
        .eq('user_id', userId)
        .eq('resume_id', resumeId)
        .order('scored_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      {
        method: 'getLatestScore',
        userId,
        resumeId,
      }
    );
  }

  async getScoreHistory(userId, limit = 50) {
    if (!userId) return [];

    const rows = await execute(
      this.query()
        .select('*')
        .eq('user_id', userId)
        .order('scored_at', { ascending: false })
        .limit(limit),
      {
        method: 'getScoreHistory',
        userId,
      }
    );

    return rows ?? [];
  }
}

module.exports = {
  ResumeRepository,
  ScoreRepository,
};