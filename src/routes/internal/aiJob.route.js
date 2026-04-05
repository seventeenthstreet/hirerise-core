'use strict';

/**
 * src/routes/internal/aiJob.route.js
 *
 * Production-safe AI job worker trigger
 * - Atomic job claim via Supabase RPC (claim_ai_job_for_processing)
 * - No SELECT → check → UPDATE race condition
 * - Single RPC call replaces 3-step DB sequence
 * - Idempotent: safe to call multiple times for the same jobId
 */

const express = require('express');
const { getClient } = require('../../config/supabase');

const { processAiJob } = require('../../core/aiJobQueue');

const logger = require('../../utils/logger');

const router = express.Router();

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function stdError(res, status, errorCode, message) {
  return res.status(status).json({
    success:   false,
    errorCode,
    message,
    timestamp: new Date().toISOString(),
  });
}

// ─────────────────────────────────────────────
// POST /
// Trigger async AI job processing
// ─────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { jobId } = req.body || {};

  // ── Input validation ────────────────────────────────────────────
  if (!jobId || typeof jobId !== 'string') {
    logger.warn('[AIJobHandler] Missing or invalid jobId', {
      body: req.body,
    });

    return stdError(
      res,
      400,
      'VALIDATION_ERROR',
      'jobId is required and must be a string.'
    );
  }

  const db = getClient();

  logger.info('[AIJobHandler] Task received', { jobId });

  try {
    // ── Atomic claim via RPC ──────────────────────────────────────
    // Replaces: SELECT → status check → UPDATE (race-prone)
    // The RPC uses FOR UPDATE SKIP LOCKED internally — one transaction,
    // one winner, no duplicate processing under concurrent workers.
    const { data: rpcResult, error: rpcError } = await db
      .rpc('claim_ai_job_for_processing', { p_job_id: jobId });

    if (rpcError) {
      logger.error('[AIJobHandler] RPC error', {
        jobId,
        error: rpcError.message,
      });

      throw rpcError;
    }

    // ── Handle non-success outcomes ───────────────────────────────
    if (!rpcResult?.success) {
      const reason = rpcResult?.reason ?? 'unknown';

      logger.info('[AIJobHandler] Job skipped', { jobId, reason });

      switch (reason) {
        // Expected skip paths — return 200 so the caller does not retry
        case 'job_not_found':
        case 'already_completed':
        case 'already_processing':
        case 'claim_conflict':
          return res.status(200).json({
            success: true,
            skipped: true,
            reason,
          });

        // Job exists but is in a terminal/unexpected state
        case 'already_failed':
          return stdError(
            res,
            422,
            'JOB_ALREADY_FAILED',
            `Job ${jobId} has already failed and cannot be reprocessed.`
          );

        case 'invalid_status':
          return stdError(
            res,
            422,
            'INVALID_JOB_STATUS',
            `Job ${jobId} is in an unprocessable status.`
          );

        // RPC-level internal error
        default:
          logger.error('[AIJobHandler] Unexpected RPC reason', {
            jobId,
            reason,
            sqlstate: rpcResult?.sqlstate,
          });

          return stdError(
            res,
            500,
            'CLAIM_ERROR',
            'Failed to claim AI job for processing.'
          );
      }
    }

    // ── Job successfully claimed — run processing ─────────────────
    const {
      id,
      operation_type,
      payload,
    } = rpcResult;

    logger.info('[AIJobHandler] Job claimed, processing started', {
      jobId,
      operation_type,
    });

    await processAiJob(id, operation_type, payload);

    logger.info('[AIJobHandler] Job processed successfully', { jobId });

    return res.status(200).json({
      success: true,
      jobId,
    });

  } catch (err) {
    logger.error('[AIJobHandler] Unexpected error', {
      jobId,
      error: err?.message,
      stack: err?.stack,
    });

    return stdError(
      res,
      500,
      'INTERNAL_ERROR',
      'AI job processing failed.'
    );
  }
});

module.exports = router;