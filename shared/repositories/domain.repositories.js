'use strict';

const { supabase } = require('../config/supabase');
const logger = require('../logger');

function nowISO() {
  return new Date().toISOString();
}

// ─────────────────────────────────────────────
// Safe Execute Wrapper
// ─────────────────────────────────────────────
async function execute(query, context) {
  const { data, error } = await query;

  if (error) {
    logger.error('DB error', { error, ...context });

    const err = new Error(error.message);
    err.code = 'DB_ERROR';
    throw err;
  }

  return data;
}

// ─────────────────────────────────────────────
// Resume Repository
// ─────────────────────────────────────────────

class ResumeRepository {
  constructor() {
    this.table = 'resumes';
  }

  // ── Get recent resumes ──
  async findByUserId(userId) {
    if (!userId) return [];

    return (
      await execute(
        supabase
          .from(this.table)
          .select('id, user_id, created_at, processing_status')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(10),
        { method: 'findByUserId', userId }
      )
    ) ?? [];
  }

  // ── Get latest active resume ──
  async findLatestByUserId(userId) {
    if (!userId) return null;

    return await execute(
      supabase
        .from(this.table)
        .select('*')
        .eq('user_id', userId)
        .eq('soft_deleted', false)
        .eq('is_primary', true)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      { method: 'findLatestByUserId', userId }
    );
  }

  // ── Safe state transitions (FIXED) ──

  async markProcessing(resumeId) {
    if (!resumeId) return;

    return await execute(
      supabase
        .from(this.table)
        .update({
          processing_status: 'processing',
          processing_started_at: nowISO(),
          updated_at: nowISO(),
        })
        .eq('id', resumeId)
        .in('processing_status', ['pending', 'failed']), // ✅ prevent overwrite
      { method: 'markProcessing', resumeId }
    );
  }

  async markComplete(resumeId, engineVersion) {
    if (!resumeId) return;

    return await execute(
      supabase
        .from(this.table)
        .update({
          processing_status: 'complete',
          processed_at: nowISO(),
          last_engine_version: engineVersion,
          updated_at: nowISO(),
        })
        .eq('id', resumeId)
        .eq('processing_status', 'processing'), // ✅ strict transition
      { method: 'markComplete', resumeId }
    );
  }

  async markFailed(resumeId, errorCode) {
    if (!resumeId) return;

    return await execute(
      supabase
        .from(this.table)
        .update({
          processing_status: 'failed',
          failed_at: nowISO(),
          last_error_code: errorCode,
          updated_at: nowISO(),
        })
        .eq('id', resumeId)
        .neq('processing_status', 'complete'), // ✅ don't override success
      { method: 'markFailed', resumeId }
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

  buildScoreId(userId, resumeId, engineVersion) {
    return `${userId}_${resumeId}_${engineVersion.replace(/\./g, '_')}`;
  }

  async upsertScore(userId, resumeId, engineVersion, scoreData = {}) {
    if (!userId || !resumeId || !engineVersion) {
      throw new Error('Missing required fields for scoring');
    }

    const id = this.buildScoreId(userId, resumeId, engineVersion);

    const payload = {
      id,
      user_id: userId,
      resume_id: resumeId,
      engine_version: engineVersion,
      ...scoreData,
      scored_at: nowISO(),
    };

    await execute(
      supabase
        .from(this.table)
        .upsert(payload, { onConflict: 'id' }), // ✅ optimized
      { method: 'upsertScore', id }
    );

    return id;
  }

  async getLatestScore(userId, resumeId) {
    if (!userId || !resumeId) return null;

    return await execute(
      supabase
        .from(this.table)
        .select('*')
        .eq('user_id', userId)
        .eq('resume_id', resumeId)
        .order('scored_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      { method: 'getLatestScore', userId, resumeId }
    );
  }

  async getScoreHistory(userId) {
    if (!userId) return [];

    return (
      await execute(
        supabase
          .from(this.table)
          .select('*')
          .eq('user_id', userId)
          .order('scored_at', { ascending: false })
          .limit(50),
        { method: 'getScoreHistory', userId }
      )
    ) ?? [];
  }
}

module.exports = {
  ResumeRepository,
  ScoreRepository,
};