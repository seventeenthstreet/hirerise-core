'use strict';

/**
 * src/modules/jobMatchPremium/repositories/jobMatchPremium.repository.js
 *
 * Repository Layer — Premium Match Analysis
 *
 * Responsibilities:
 * - Persist premium match analysis to resume_analyses
 * - Read latest analysis by resumeId + userId
 *
 * Rules:
 * - NO raw resume text persisted
 * - NO PII in persisted payload
 * - NO business logic — pure DB operations
 * - Returns null (not throws) for missing records on read
 */

const { supabase } = require('../../../config/supabase');
const logger       = require('../../../utils/logger');
const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');

const TABLE = 'resume_analyses';
const OPERATION_TYPE = 'jobMatchPremium';

// ─────────────────────────────────────────────────────────────────────────────
// PERSIST
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persists a premium match analysis record.
 *
 * @param {object} record
 * @returns {Promise<{ id: string }>}
 */
async function persistAnalysis(record) {
  const row = {
    resume_id:           record.resumeId,
    user_id:             record.userId,
    engine:              'premium_match',
    operation_type:      OPERATION_TYPE,
    analysis_hash:       record.analysisHash ?? null,
    match_score:         record.matchScore,
    tier:                record.tier,
    breakdown:           record.breakdown ?? null,
    skill_gap:           record.skillGap ?? null,
    explanation:         record.explanation ?? null,
    insights:            record.insights ?? null,
    ai_model_version:    record.aiModelVersion ?? null,
    cache_hit:           record.cacheHit ?? false,
    latency_ms:          record.latencyMs ?? null,
    token_input_count:   record.tokenInputCount ?? null,
    token_output_count:  record.tokenOutputCount ?? null,
    ai_cost_usd:         record.aiCostUsd ?? null,
    created_at:          new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from(TABLE)
    .insert(row)
    .select('id')
    .single();

  if (error) {
    logger.error('[JobMatchPremiumRepo] persist failed', {
      resumeId: record.resumeId,
      error: error.message,
    });
    throw new AppError(
      'Failed to persist premium match analysis',
      500,
      { resumeId: record.resumeId },
      ErrorCodes.INTERNAL_ERROR
    );
  }

  return { id: data.id };
}

// ─────────────────────────────────────────────────────────────────────────────
// READ LATEST
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads the most recent premium match analysis for a resume.
 *
 * @param {string} resumeId
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
async function findLatestAnalysis(resumeId, userId) {
  const { data, error } = await supabase
    .from(TABLE)
    .select(`
      id,
      resume_id,
      user_id,
      match_score,
      tier,
      breakdown,
      skill_gap,
      explanation,
      insights,
      ai_model_version,
      cache_hit,
      latency_ms,
      token_input_count,
      token_output_count,
      ai_cost_usd,
      analysis_hash,
      created_at
    `)
    .eq('resume_id', resumeId)
    .eq('user_id', userId)
    .eq('operation_type', OPERATION_TYPE)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    logger.warn('[JobMatchPremiumRepo] findLatest failed', {
      resumeId,
      error: error.message,
    });
    return null;
  }

  return data;
}

module.exports = { persistAnalysis, findLatestAnalysis };
