'use strict';

const crypto = require('crypto');
const logger = require('../utils/logger');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

const JOB_COLLECTION = 'ai_jobs';

const JOB_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed'
};

const MAX_RETRIES = 2;
const JOB_TIMEOUT_MS = 20000;

// ─────────────────────────────────────────────
// Supabase
// ─────────────────────────────────────────────

function getSupabase() {
  return require('../config/supabase').supabase;
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function _createJobDoc(jobId, userId, operationType, payload) {
  const now = new Date().toISOString();

  return {
    id: jobId,
    user_id: userId,
    operation_type: operationType,
    status: JOB_STATUS.PENDING,
    payload: payload || {},
    result: null,
    error: null,
    retries: 0,
    created_at: now,
    updated_at: now,
    started_at: null,
    completed_at: null
  };
}

async function _updateJob(jobId, fields) {
  const supabase = getSupabase();

  const { error } = await supabase
    .from(JOB_COLLECTION)
    .update({
      ...fields,
      updated_at: new Date().toISOString()
    })
    .eq('id', jobId);

  if (error) {
    throw new AppError('Failed to update job', 500, null, ErrorCodes.DB_ERROR);
  }
}

// ─────────────────────────────────────────────
// Safe Dispatcher
// ─────────────────────────────────────────────

function _dispatch(jobId, operationType, payload) {
  setTimeout(() => {
    processAiJob(jobId, operationType, payload).catch(err => {
      logger.error('[AIJobQueue] Background failure', { jobId, error: err.message });
    });
  }, 0);
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

async function enqueueAiJob({ userId, operationType, payload = {} }) {
  if (!userId) throw new AppError('userId required', 400);
  if (!operationType) throw new AppError('operationType required', 400);

  const jobId = crypto.randomUUID();
  const jobDoc = _createJobDoc(jobId, userId, operationType, payload);
  const supabase = getSupabase();

  const { error } = await supabase.from(JOB_COLLECTION).insert(jobDoc);

  if (error) {
    throw new AppError('Failed to enqueue job', 500, null, ErrorCodes.DB_ERROR);
  }

  logger.info('[AIJobQueue] Job enqueued', { jobId });

  _dispatch(jobId, operationType, payload);

  return { jobId };
}

// ─────────────────────────────────────────────
// LOCK ACQUIRE (CRITICAL)
// ─────────────────────────────────────────────

async function _acquireJobLock(jobId) {
  const supabase = getSupabase();

  const { data } = await supabase
    .from(JOB_COLLECTION)
    .update({
      status: JOB_STATUS.PROCESSING,
      started_at: new Date().toISOString()
    })
    .eq('id', jobId)
    .eq('status', JOB_STATUS.PENDING) // 🔥 atomic guard
    .select()
    .maybeSingle();

  return !!data;
}

// ─────────────────────────────────────────────
// Core Processor
// ─────────────────────────────────────────────

async function processAiJob(jobId, operationType, payload) {
  const supabase = getSupabase();

  const locked = await _acquireJobLock(jobId);

  if (!locked) {
    logger.warn('[AIJobQueue] Skipped (already processing)', { jobId });
    return;
  }

  let result;

  try {
    result = await Promise.race([
      _executeOperation(operationType, payload),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('JOB_TIMEOUT')), JOB_TIMEOUT_MS)
      )
    ]);

    await _updateJob(jobId, {
      status: JOB_STATUS.COMPLETED,
      result,
      completed_at: new Date().toISOString()
    });

    logger.info('[AIJobQueue] Job completed', { jobId });

  } catch (err) {
    logger.error('[AIJobQueue] Job failed', { jobId, error: err.message });

    const { data } = await supabase
      .from(JOB_COLLECTION)
      .select('retries')
      .eq('id', jobId)
      .maybeSingle();

    const retries = data?.retries || 0;

    if (retries < MAX_RETRIES) {
      await _updateJob(jobId, {
        status: JOB_STATUS.PENDING,
        retries: retries + 1
      });

      logger.warn('[AIJobQueue] Retrying job', { jobId, retries: retries + 1 });

      _dispatch(jobId, operationType, payload);
      return;
    }

    await _updateJob(jobId, {
      status: JOB_STATUS.FAILED,
      error: { message: err.message }
    });
  }
}

// ─────────────────────────────────────────────
// Operation Router
// ─────────────────────────────────────────────

async function _executeOperation(operationType, payload) {
  if (operationType === 'chi_calculation' || operationType === 'fullAnalysis') {
    const { runFullPipeline } = require('./pipeline.connector');

    return await runFullPipeline({
      user_id: payload.userId,
      resumeId: payload.resumeId
    });

  } else if (operationType === 'jobSpecificCV') {
    const { scoreResume } = require('../modules/resume/resume.service');

    return await scoreResume(payload.userId, payload.resumeId);
  }

  throw new AppError(`Unknown operationType: ${operationType}`, 400);
}

// ─────────────────────────────────────────────
// Status API (unchanged)
// ─────────────────────────────────────────────

async function getJobStatus(jobId, userId) {
  const supabase = getSupabase();

  const { data } = await supabase
    .from(JOB_COLLECTION)
    .select('*')
    .eq('id', jobId)
    .maybeSingle();

  if (!data || data.user_id !== userId) {
    throw new AppError('Job not found', 404);
  }

  return {
    jobId,
    status: data.status,
    result: data.result,
    error: data.error
  };
}

module.exports = {
  enqueueAiJob,
  getJobStatus,
  processAiJob
};