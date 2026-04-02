'use strict';

const crypto = require('crypto');
const jobSyncService = require('../services/jobSync.service');
const { validateSyncRequest } = require('../validators/jobSync.validator');
const logger = require('../../../../utils/logger');

const MAX_RESPONSE_ERRORS = 200;

/**
 * Extract authenticated user ID from Supabase/JWT middleware
 */
function getAuthenticatedUserId(req) {
  return (
    req.user?.id ||
    req.user?.userId ||
    req.auth?.userId ||
    req.auth?.sub ||
    null
  );
}

async function syncJobs(req, res, next) {
  const requestId =
    req.headers['x-request-id'] ||
    req.headers['x-correlation-id'] ||
    crypto.randomUUID();

  try {
    // 1) Validate request payload
    const { value: body, error } = validateSyncRequest(req.body);

    if (error) {
      return res.status(400).json({
        success: false,
        message: 'Invalid request body',
        errors: error.details.map((detail) => ({
          field: detail.context?.key || null,
          message: detail.message,
        })),
      });
    }

    // 2) Supabase-authenticated user enforcement
    const initiatedBy = getAuthenticatedUserId(req);

    if (!initiatedBy) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized',
      });
    }

    logger.info('[JobSyncController.syncJobs] started', {
      requestId,
      sourceType: body.sourceType,
      initiatedBy,
    });

    // 3) Delegate to service layer
    const result = await jobSyncService.syncJobs({
      sourceType: body.sourceType,
      sourceUrl: body.sourceUrl,
      options: body.options,
      initiatedBy,
    });

    const safeResult = {
      total: result?.total || 0,
      success: result?.success || 0,
      failed: result?.failed || 0,
      errors: Array.isArray(result?.errors) ? result.errors : [],
    };

    const statusCode =
      safeResult.failed > 0 && safeResult.success === 0 ? 422 : 200;

    return res.status(statusCode).json({
      success: safeResult.failed === 0,
      message: `Job sync complete. ${safeResult.success} succeeded, ${safeResult.failed} failed out of ${safeResult.total} records.`,
      data: {
        total: safeResult.total,
        success: safeResult.success,
        failed: safeResult.failed,
        errors: safeResult.errors.slice(0, MAX_RESPONSE_ERRORS),
      },
    });
  } catch (err) {
    // Lock conflict from service
    if (err?.statusCode === 409) {
      logger.warn('[JobSyncController.syncJobs] lock conflict', {
        requestId,
        reason: err.message,
      });

      return res.status(409).json({
        success: false,
        message: 'Another job sync is currently running. Please try again later.',
      });
    }

    logger.error('[JobSyncController.syncJobs] unhandled error', {
      requestId,
      error: err?.message,
      stack: err?.stack,
    });

    return next(err);
  }
}

module.exports = { syncJobs };