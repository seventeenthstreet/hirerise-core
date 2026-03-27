'use strict';

/**
 * aiJob.route.js — Internal Cloud Tasks callback handler for async AI jobs
 *
 * POST /api/v1/internal/ai-job
 *
 * Called by Google Cloud Tasks after enqueueAiJob() creates a task.
 * Protected by requireInternalToken — NOT by auth token.
 *
 * PAYLOAD (JSON body from Cloud Tasks):
 *   { jobId: string }
 *
 * RESPONSE CODES:
 *   200 — Job processed successfully (or gracefully handled, e.g. duplicate call)
 *   400 — Missing jobId (non-retryable — bad task payload)
 *   404 — Job not found or already completed (non-retryable)
 *   500 — Unexpected error (Cloud Tasks WILL retry on 5xx with exponential backoff)
 *
 * IDEMPOTENCY:
 *   Cloud Tasks may deliver a task more than once (at-least-once delivery).
 *   The handler checks job status before processing:
 *     - 'pending'    → process normally
 *     - 'processing' → another instance is already working on it; return 200
 *     - 'completed'  → already done; return 200 (prevents double-processing)
 *     - 'failed'     → was marked failed; Cloud Tasks is retrying; re-process
 *
 * REGISTRATION (server.js):
 *   app.use(
 *     '/api/v1/internal/ai-job',
 *     requireInternalToken,
 *     require('./routes/internal/aiJob.route'),
 *   );
 *
 * @module routes/internal/aiJob.route
 */
const express = require('express');
const {
  db
} = require('../../config/supabase');
const {
  processAiJob,
  JOB_STATUS,
  JOB_COLLECTION
} = require('../../core/aiJobQueue');
const logger = require('../../utils/logger');
const router = express.Router();
router.post('/', async (req, res) => {
  const {
    jobId
  } = req.body || {};

  // ── Input validation ──────────────────────────────────────────────────────
  if (!jobId || typeof jobId !== 'string') {
    logger.warn('[AIJobHandler] Missing or invalid jobId in task payload', {
      body: req.body
    });
    // 400 — non-retryable (bad task payload — Cloud Tasks will not retry on 4xx)
    return res.status(400).json({
      success: false,
      errorCode: 'VALIDATION_ERROR',
      message: 'jobId is required and must be a string.'
    });
  }
  logger.info('[AIJobHandler] Task received', {
    jobId
  });
  try {
    // ── Fetch job document ────────────────────────────────────────────────
    const snap = await supabase.from(JOB_COLLECTION).select("*").eq("id", jobId).single();
    if (!snap.exists) {
      logger.warn('[AIJobHandler] Job not found — skipping', {
        jobId
      });
      // 200 — non-retryable (job may have been deleted or never written)
      return res.status(200).json({
        success: true,
        skipped: true,
        reason: 'job_not_found'
      });
    }
    const job = snap.data();

    // ── Idempotency check ─────────────────────────────────────────────────
    if (job.status === JOB_STATUS.COMPLETED) {
      logger.info('[AIJobHandler] Job already completed — skipping duplicate delivery', {
        jobId
      });
      return res.status(200).json({
        success: true,
        skipped: true,
        reason: 'already_completed'
      });
    }
    if (job.status === JOB_STATUS.PROCESSING) {
      // Another replica is already processing — return 200 so Cloud Tasks doesn't retry.
      // If the other replica crashes, the job will be left in 'processing' state.
      // A separate janitor process (future Phase 3) can detect stale 'processing' jobs.
      logger.info('[AIJobHandler] Job already processing — concurrent delivery detected', {
        jobId
      });
      return res.status(200).json({
        success: true,
        skipped: true,
        reason: 'already_processing'
      });
    }

    // ── Process the job ───────────────────────────────────────────────────
    await processAiJob(jobId, job.operationType, job.payload);
    return res.status(200).json({
      success: true,
      jobId
    });
  } catch (err) {
    logger.error('[AIJobHandler] Unexpected error processing job', {
      jobId,
      error: err.message,
      stack: err.stack
    });
    // 500 — Cloud Tasks WILL retry with exponential backoff
    return res.status(500).json({
      success: false,
      errorCode: 'INTERNAL_ERROR',
      message: 'AI job processing failed.'
    });
  }
});
module.exports = router;