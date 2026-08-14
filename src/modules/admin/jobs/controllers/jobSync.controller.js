'use strict';

const crypto = require('crypto');
const jobSyncService = require('../services/jobSync.service');
const {
  validateSyncRequest,
  validateCsvUploadOptions,
} = require('../validators/jobSync.validator');
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

/**
 * Shared response envelope for both syncJobs() and uploadJobsCsv() —
 * same shape the frontend's JobSyncPanel already renders
 * ("N succeeded, M failed out of T records").
 */
function sendSyncResult(res, result) {
  const safeResult = {
    total: result?.total || 0,
    success: result?.success || 0,
    failed: result?.failed || 0,
    errors: Array.isArray(result?.errors) ? result.errors : [],
  };

  const statusCode =
    safeResult.failed > 0 && safeResult.success === 0 ? 422 : 200;

  const message = `Job sync complete. ${safeResult.success} succeeded, ${safeResult.failed} failed out of ${safeResult.total} records.`;

  const data = {
    total: safeResult.total,
    success: safeResult.success,
    failed: safeResult.failed,
    errors: safeResult.errors.slice(0, MAX_RESPONSE_ERRORS),
  };

  const responseBody = { success: safeResult.failed === 0, message, data };

  // BUGFIX (CSV/URL sync 422 swallowed by frontend): any non-200 response
  // from this shared envelope MUST also carry a V2-shaped `error` object
  // ({ code, message, details }). The frontend's parseApiResponse /
  // parseBackendError (front/src/lib/api/core/api-parser.ts) only
  // recognises a failure body when `success:false` is paired with an
  // `error` object (its V2 shape) or one of a few tolerated legacy
  // shapes (`error` as a string, `code`/`errorCode`, or a NestJS-style
  // `statusCode`+`message`). A `{ success:false, message, data }` body
  // -- what this endpoint used to send unconditionally -- matches NONE
  // of those branches, so parseBackendError falls through to its
  // generic FALLBACK_MESSAGE ('Unexpected server response') and the
  // real per-record validation errors in `data.errors` never reach the
  // admin. Adding `error` here is purely additive -- success/message/
  // data are unchanged, so this stays compatible with every existing
  // consumer of this shape (including the 200 partial-success path,
  // which is left untouched below).
  if (statusCode !== 200) {
    responseBody.error = {
      code: 'JOB_SYNC_PARTIAL_FAILURE',
      message,
      details: data,
    };
  }

  return res.status(statusCode).json(responseBody);
}

/**
 * Shared error handling for both syncJobs() and uploadJobsCsv() — same
 * lock-conflict (409) and unhandled-error behavior either entry point
 * can hit, since both ultimately call into jobSyncService.
 */
function handleSyncError(err, req, res, next, requestId, logLabel) {
  if (err?.statusCode === 409) {
    logger.warn(`[JobSyncController.${logLabel}] lock conflict`, {
      requestId,
      reason: err.message,
    });

    return res.status(409).json({
      success: false,
      message: 'Another job sync is currently running. Please try again later.',
    });
  }

  logger.error(`[JobSyncController.${logLabel}] unhandled error`, {
    requestId,
    error: err?.message,
    stack: err?.stack,
  });

  return next(err);
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

    return sendSyncResult(res, result);
  } catch (err) {
    return handleSyncError(err, req, res, next, requestId, 'syncJobs');
  }
}

/**
 * POST /admin/jobs/sync/upload — WP-ADMIN-COMP-06-R2.
 *
 * Multer (memoryStorage, field name "file") has already run by the time
 * this handler executes (wired in adminJobs.routes.js) and populated
 * req.file.buffer / req.file.originalname, or rejected the request
 * before reaching here (size/MIME/extension failures are normalized to
 * the standard error envelope at the route layer). This handler mirrors
 * syncJobs() above exactly, just fed from the uploaded buffer instead of
 * a request-body sourceUrl — same auth check, same service-layer
 * delegation pattern, same response/error shape.
 */
async function uploadJobsCsv(req, res, next) {
  const requestId =
    req.headers['x-request-id'] ||
    req.headers['x-correlation-id'] ||
    crypto.randomUUID();

  try {
    // 1) A file must have been attached (field name "file")
    if (!req.file?.buffer?.length) {
      return res.status(400).json({
        success: false,
        message: 'No CSV file uploaded. Attach a file with field name "file".',
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

    // 3) Normalise optional delimiter/skipHeader form fields
    const { value: options } = validateCsvUploadOptions(req.body);

    logger.info('[JobSyncController.uploadJobsCsv] started', {
      requestId,
      fileName: req.file.originalname,
      fileSizeBytes: req.file.buffer.length,
      initiatedBy,
    });

    // 4) Delegate to service layer — reuses the exact same ingestion
    // pipeline (validate/chunk/bulkUpsert/log) as syncJobs() above.
    const result = await jobSyncService.syncJobsFromCsvUpload({
      csvBuffer: req.file.buffer,
      options,
      initiatedBy,
      fileName: req.file.originalname,
    });

    return sendSyncResult(res, result);
  } catch (err) {
    return handleSyncError(err, req, res, next, requestId, 'uploadJobsCsv');
  }
}

module.exports = { syncJobs, uploadJobsCsv };