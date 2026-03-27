'use strict';

/**
 * aiJobQueue.js — Async AI Job Queue
 *
 * Provides:
 *   enqueueAiJob(params)        — create a job doc in ai_jobs and dispatch it
 *   getJobStatus(jobId, userId) — poll job status (ownership-checked)
 *   processAiJob(jobId, operationType, payload) — execute a job (called by internal route)
 *   JOB_STATUS                  — status enum
 *   JOB_COLLECTION              — Supabase table name
 *
 * Dispatch strategy (in priority order):
 *   1. Inline async (setTimeout) — always available, zero infra dependency.
 *      For dev and any env without Cloud Tasks / Pub/Sub configured.
 *   2. Extend with Cloud Tasks / Pub/Sub by swapping _dispatch() if needed.
 *
 * Job document shape (ai_jobs table):
 *   id             TEXT PRIMARY KEY
 *   user_id        TEXT NOT NULL
 *   operation_type TEXT NOT NULL   — 'chi_calculation' | 'fullAnalysis' | 'jobSpecificCV'
 *   status         TEXT NOT NULL   — pending | processing | completed | failed
 *   payload        JSONB
 *   result         JSONB
 *   error          JSONB
 *   created_at     TIMESTAMPTZ
 *   updated_at     TIMESTAMPTZ
 *   started_at     TIMESTAMPTZ
 *   completed_at   TIMESTAMPTZ
 */
const crypto = require('crypto');
const logger = require('../utils/logger');

// ─── Constants ────────────────────────────────────────────────────────────────

const JOB_COLLECTION = 'ai_jobs';
const JOB_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed'
};

// ─── Lazy Supabase accessor ───────────────────────────────────────────────────

function getSupabase() {
  return require('../config/supabase').supabase;
}

// ─── Job document helpers ─────────────────────────────────────────────────────

function _createJobDoc(jobId, userId, operationType, payload) {
  const now = new Date().toISOString();
  return {
    id: jobId,
    userId,
    operationType,
    status: JOB_STATUS.PENDING,
    payload: payload || {},
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null
  };
}

async function _updateJob(jobId, fields) {
  const supabase = getSupabase();
  const { error } = await supabase
    .from(JOB_COLLECTION)
    .update({
      ...fields,
      updatedAt: new Date().toISOString()
    })
    .eq('id', jobId);

  if (error) {
    throw new Error(`[AIJobQueue] Failed to update job ${jobId}: ${error.message}`);
  }
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

/**
 * Dispatch the job for async processing.
 * Uses a fire-and-forget setTimeout so the upload HTTP response is sent
 * immediately while processing continues in the background.
 *
 * In production you can replace this with Cloud Tasks / Pub/Sub
 * by adding the relevant env vars and swapping the implementation here.
 */
function _dispatch(jobId, operationType, payload) {
  // Run after current event loop tick so the HTTP response is sent first.
  setTimeout(async () => {
    try {
      await processAiJob(jobId, operationType, payload);
    } catch (err) {
      logger.error('[AIJobQueue] Background job failed unexpectedly', {
        jobId,
        operationType,
        error: err.message,
        stack: err.stack
      });
    }
  }, 0);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * enqueueAiJob({ userId, operationType, payload })
 *
 * Writes a job document to ai_jobs and schedules async processing.
 * Returns { jobId } immediately so callers can give the client a poll URL.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.operationType   — 'chi_calculation' | 'fullAnalysis' | 'jobSpecificCV'
 * @param {object} [params.payload]       — arbitrary data passed to the processor
 * @returns {Promise<{ jobId: string }>}
 */
async function enqueueAiJob({ userId, operationType, payload = {} }) {
  if (!userId) throw new Error('[AIJobQueue] userId is required');
  if (!operationType) throw new Error('[AIJobQueue] operationType is required');

  const jobId = crypto.randomUUID();
  const jobDoc = _createJobDoc(jobId, userId, operationType, payload);
  const supabase = getSupabase();

  const { error } = await supabase
    .from(JOB_COLLECTION)
    .insert(jobDoc);

  if (error) {
    throw new Error(`[AIJobQueue] Failed to enqueue job: ${error.message}`);
  }

  logger.info('[AIJobQueue] Job enqueued', { jobId, userId, operationType });

  // Dispatch async — does not block the caller
  _dispatch(jobId, operationType, payload);
  return { jobId };
}

/**
 * getJobStatus(jobId, userId)
 *
 * Returns the current job status. Enforces ownership — silently returns
 * a 404-like object if the job belongs to a different user.
 *
 * @param {string} jobId
 * @param {string} userId   — from req.user.uid (auth token)
 * @returns {Promise<object>}  job status shape
 */
async function getJobStatus(jobId, userId) {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from(JOB_COLLECTION)
    .select('*')
    .eq('id', jobId)
    .maybeSingle();

  if (error) {
    throw new Error(`[AIJobQueue] Failed to fetch job status: ${error.message}`);
  }

  if (!data) {
    const { AppError, ErrorCodes } = require('../middleware/errorHandler');
    throw new AppError('Job not found', 404, null, ErrorCodes.NOT_FOUND);
  }

  const job = data;

  // Ownership check — silent 404 to prevent job ID enumeration
  if (job.userId !== userId) {
    const { AppError, ErrorCodes } = require('../middleware/errorHandler');
    throw new AppError('Job not found', 404, null, ErrorCodes.NOT_FOUND);
  }

  const base = {
    jobId,
    operationType: job.operationType,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };

  if (job.status === JOB_STATUS.COMPLETED) {
    return {
      ...base,
      result: job.result,
      completedAt: job.completedAt
    };
  }

  if (job.status === JOB_STATUS.FAILED) {
    return {
      ...base,
      error: job.error
    };
  }

  return base;
}

/**
 * processAiJob(jobId, operationType, payload)
 *
 * Execute the actual work for a job. Called by:
 *   - _dispatch() (inline async, dev/default)
 *   - POST /api/v1/internal/ai-job (Cloud Tasks callback)
 *
 * Marks the job processing → completed | failed in ai_jobs.
 *
 * @param {string} jobId
 * @param {string} operationType
 * @param {object} payload
 */
async function processAiJob(jobId, operationType, payload) {
  logger.info('[AIJobQueue] Processing job', { jobId, operationType });

  // Mark as processing
  await _updateJob(jobId, {
    status: JOB_STATUS.PROCESSING,
    startedAt: new Date().toISOString()
  });

  let result;
  try {
    if (operationType === 'chi_calculation') {
      // Run the full pipeline: parsedData → profile → score → match → CHI
      const { runFullPipeline } = require('./pipeline.connector');
      result = await runFullPipeline({
        user_id: payload.userId,
        resumeId: payload.resumeId
      });
    } else if (operationType === 'fullAnalysis') {
      // Legacy full analysis — reuse chi_calculation pipeline
      const { runFullPipeline } = require('./pipeline.connector');
      result = await runFullPipeline({
        user_id: payload.userId,
        resumeId: payload.resumeId
      });
    } else if (operationType === 'jobSpecificCV') {
      // Job-specific CV tailoring — handled by resume scoring service
      const { scoreResume } = require('../modules/resume/resume.service');
      result = await scoreResume(payload.userId, payload.resumeId);
    } else {
      throw new Error(`Unknown operationType: "${operationType}"`);
    }

    // Mark as completed
    await _updateJob(jobId, {
      status: JOB_STATUS.COMPLETED,
      result: result || null,
      completedAt: new Date().toISOString()
    });

    logger.info('[AIJobQueue] Job completed', { jobId, operationType });
  } catch (err) {
    logger.error('[AIJobQueue] Job failed', {
      jobId,
      operationType,
      error: err.message,
      stack: err.stack
    });

    // Mark as failed — Cloud Tasks will retry on 500, so this is for inline dispatch
    await _updateJob(jobId, {
      status: JOB_STATUS.FAILED,
      error: {
        message: err.message,
        code: err.code || err.errorCode || 'INTERNAL_ERROR'
      }
    }).catch(updateErr => {
      // Don't let a failed status update mask the original error
      logger.warn('[AIJobQueue] Failed to mark job as failed', {
        jobId,
        updateErr: updateErr.message
      });
    });

    throw err; // Re-throw so Cloud Tasks route returns 500 and retries
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  JOB_COLLECTION,
  JOB_STATUS,
  enqueueAiJob,
  getJobStatus,
  processAiJob
};