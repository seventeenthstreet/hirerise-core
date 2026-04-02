'use strict';

/**
 * aiJob.route.js — Supabase fixed
 */

const express = require('express');
const { supabase } = require('../../config/supabase');

const {
  processAiJob,
  JOB_STATUS,
  JOB_COLLECTION
} = require('../../core/aiJobQueue');

const logger = require('../../utils/logger');

const router = express.Router();

router.post('/', async (req, res) => {

  const { jobId } = req.body || {};

  // ── Input validation ─────────────────────────────────────
  if (!jobId || typeof jobId !== 'string') {
    logger.warn('[AIJobHandler] Missing or invalid jobId', { body: req.body });

    return res.status(400).json({
      success: false,
      errorCode: 'VALIDATION_ERROR',
      message: 'jobId is required and must be a string.'
    });
  }

  logger.info('[AIJobHandler] Task received', { jobId });

  try {

    // ── Fetch job (FIXED) ─────────────────────────────────
    const { data, error } = await supabase
      .from(JOB_COLLECTION)
      .select('*')
      .eq('id', jobId)
      .maybeSingle();

    if (error) {
      logger.error('[AIJobHandler] DB error', { jobId, error: error.message });
      throw error;
    }

    if (!data) {
      logger.warn('[AIJobHandler] Job not found — skipping', { jobId });

      return res.status(200).json({
        success: true,
        skipped: true,
        reason: 'job_not_found'
      });
    }

    const job = data;

    // ── Idempotency ───────────────────────────────────────
    if (job.status === JOB_STATUS.COMPLETED) {
      logger.info('[AIJobHandler] Already completed', { jobId });

      return res.status(200).json({
        success: true,
        skipped: true,
        reason: 'already_completed'
      });
    }

    if (job.status === JOB_STATUS.PROCESSING) {
      logger.info('[AIJobHandler] Already processing', { jobId });

      return res.status(200).json({
        success: true,
        skipped: true,
        reason: 'already_processing'
      });
    }

    // ── Process job ───────────────────────────────────────
    await processAiJob(jobId, job.operationType, job.payload);

    return res.status(200).json({
      success: true,
      jobId
    });

  } catch (err) {

    logger.error('[AIJobHandler] Unexpected error', {
      jobId,
      error: err.message,
      stack: err.stack
    });

    return res.status(500).json({
      success: false,
      errorCode: 'INTERNAL_ERROR',
      message: 'AI job processing failed.'
    });
  }
});

module.exports = router;