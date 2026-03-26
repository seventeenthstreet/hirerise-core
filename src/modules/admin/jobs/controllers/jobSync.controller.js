'use strict';

const crypto = require('crypto');
const jobSyncService = require('../services/jobSync.service');
const { validateSyncRequest } = require('../validators/jobSync.validator');
const logger = require('../../../../utils/logger');

const MAX_RESPONSE_ERRORS = 200; // prevent huge payloads

async function syncJobs(req, res, next) {
  const requestId = req.headers['x-request-id'] || crypto.randomUUID();

  try {
    // 1. Validate request body
    const { value: body, error } = validateSyncRequest(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: 'Invalid request body',
        errors: error.details.map((d) => ({
          field: d.context?.key ?? null,
          message: d.message,
        })),
      });
    }

    // 2. Enforce authenticated user
    const initiatedBy = req.user?.uid ?? req.user?.id;
    if (!initiatedBy) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized',
      });
    }

    logger.info('[JobSyncController.syncJobs] initiated', {
      requestId,
      sourceType: body.sourceType,
      initiatedBy,
    });

    // 3. Delegate to service
    const result = await jobSyncService.syncJobs({
      sourceType: body.sourceType,
      sourceUrl:  body.sourceUrl,
      options:    body.options,
      initiatedBy,
    });

    const statusCode =
      result.failed > 0 && result.success === 0 ? 422 : 200;

    return res.status(statusCode).json({
      success: result.failed === 0,
      message: `Job sync complete. ${result.success} succeeded, ${result.failed} failed out of ${result.total} records.`,
      data: {
        total:   result.total,
        success: result.success,
        failed:  result.failed,
        errors:  result.errors.slice(0, MAX_RESPONSE_ERRORS),
      },
    });

  } catch (err) {

    if (err.statusCode === 409) {
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
      error: err.message,
    });

    next(err);
  }
}

module.exports = { syncJobs };








