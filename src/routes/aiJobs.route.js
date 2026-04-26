'use strict';

/**
 * routes/aiJobs.route.js
 *
 * @deprecated LEGACY — not for frontend use.
 *
 * This endpoint exposes raw AI job status by jobId.
 * It is an INTERNAL backend mechanism.
 *
 * Frontend MUST NOT poll this endpoint.
 * Use the canonical resume-based polling endpoint instead:
 *   GET /api/v1/resumes/:resumeId           — full resume record + status
 *   GET /api/v1/resumes/:resumeId/status    — lightweight status-only poll
 *
 * This route is retained for backward compatibility with internal
 * backend workers and admin tooling ONLY. It will not be removed,
 * but it will never be the correct choice for new frontend code.
 *
 * Client poll endpoint for async AI job status.
 *
 * GET /api/v1/ai-jobs/:jobId
 *
 * Protected by authenticate middleware.
 * Ownership enforcement is delegated to getJobStatus(jobId, userId).
 *
 * Response behavior intentionally preserved:
 * - 200 for pending / processing / completed / failed
 * - 404 for not found or unauthorized ownership
 * - 400 for invalid jobId
 */

const express = require('express');
const { getJobStatus } = require('../core/aiJobQueue');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * Extract authenticated user ID in an auth-provider-agnostic way.
 *
 * Supports:
 * - Supabase JWT middleware → req.user.id
 * - legacy Firebase middleware → req.user.id
 * - internal normalized auth → req.auth.userId
 */
function resolveAuthenticatedUserId(req) {
  return (
    req?.user?.id ||
    req?.user?.uid ||
    req?.auth?.userId ||
    req?.user?.user_id ||
    null
  );
}

/**
 * Strict jobId validation
 * Allows:
 * - UUIDs
 * - ULIDs
 * - queue-generated safe identifiers
 */
function isValidJobId(jobId) {
  return (
    typeof jobId === 'string' &&
    jobId.length > 0 &&
    jobId.length <= 64 &&
    /^[A-Za-z0-9_-]+$/.test(jobId)
  );
}

router.get('/:jobId', async (req, res, next) => {
  const requestMeta = {
    route: 'GET /ai-jobs/:jobId',
    requestId: req.id || null,
  };

  // DEPRECATION NOTICE: this endpoint is legacy / internal only.
  // Frontend should poll GET /api/v1/resumes/:resumeId/status instead.
  res.setHeader(
    'Deprecation',
    'true'
  );
  res.setHeader(
    'Link',
    '</api/v1/resumes/{resumeId}/status>; rel="successor-version"'
  );
  res.setHeader(
    'X-Polling-Contract',
    'DEPRECATED: use GET /api/v1/resumes/:resumeId/status — see frontend-contract.md'
  );

  logger.warn('[AIJobsRoute] Legacy job-poll endpoint called — frontend should use /resumes/:resumeId/status', {
    ...requestMeta,
    jobId: req.params?.jobId,
  });

  try {
    const { jobId } = req.params;
    const userId = resolveAuthenticatedUserId(req);

    if (!userId) {
      logger.warn('[AIJobsRoute] Missing authenticated user context', {
        ...requestMeta,
      });

      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required.',
        },
      });
    }

    if (!isValidJobId(jobId)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid jobId.',
        },
      });
    }

    const job = await getJobStatus(jobId, userId);

    logger.debug('[AIJobsRoute] Poll request completed', {
      ...requestMeta,
      userId,
      jobId,
      status: job?.status || 'unknown',
    });

    return res.status(200).json({
      success: true,
      data: job,
    });
  } catch (error) {
    logger.error('[AIJobsRoute] Failed to fetch job status', {
      ...requestMeta,
      jobId: req?.params?.jobId || null,
      userId: resolveAuthenticatedUserId(req),
      error: error.message,
      stack: error.stack,
    });

    return next(error);
  }
});

module.exports = router;