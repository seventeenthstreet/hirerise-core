'use strict';

/**
 * src/middleware/errorHandler.js
 *
 * Centralised error handler + AppError class.
 *
 * FIX: Added DB_ERROR and INTERNAL_SERVER_ERROR to ErrorCodes.
 * Both were referenced across the codebase (resume.service.js,
 * creditGuard.middleware.js) but undefined here, causing error
 * objects to carry undefined errorCode fields.
 */

const logger = require('../utils/logger');
const crypto = require('crypto');
const { sendAlert, SEVERITY } = require('../monitoring/alerts');

// ─────────────────────────────────────────────────────────────────────────────
// APP ERROR
// ─────────────────────────────────────────────────────────────────────────────

class AppError extends Error {
  constructor(
    message,
    statusCode = 500,
    details    = null,
    errorCode  = null,
    userMessage = null
  ) {
    super(message);

    this.name        = 'AppError';
    this.statusCode  = statusCode;
    this.details     = details;
    this.errorCode   = errorCode;
    this.userMessage = userMessage;
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ERROR CODES
// FIX: Added DB_ERROR (used by resume.service.js, aiJobQueue.js) and
//      INTERNAL_SERVER_ERROR alias (used by creditGuard.middleware.js).
// ─────────────────────────────────────────────────────────────────────────────

const ErrorCodes = Object.freeze({
  INTERNAL_ERROR:        'INTERNAL_ERROR',
  INTERNAL_SERVER_ERROR: 'INTERNAL_ERROR',  // ← FIX: alias used by creditGuard
  DB_ERROR:              'DB_ERROR',         // ← FIX: used by resume.service, aiJobQueue
  NOT_FOUND:             'NOT_FOUND',
  VALIDATION_ERROR:      'VALIDATION_ERROR',
  RATE_LIMITED:          'RATE_LIMITED',
  UNAUTHORIZED:          'UNAUTHORIZED',
  FORBIDDEN:             'FORBIDDEN',
  CONFLICT:              'CONFLICT',

  ROLE_NOT_FOUND:          'ROLE_NOT_FOUND',
  SALARY_BAND_NOT_FOUND:   'SALARY_BAND_NOT_FOUND',
  INVALID_EXPERIENCE:      'INVALID_EXPERIENCE',
  SKILL_DATA_NOT_FOUND:    'SKILL_DATA_NOT_FOUND',
  CAREER_PATH_NOT_FOUND:   'CAREER_PATH_NOT_FOUND',
  JD_PARSE_FAILED:         'JD_PARSE_FAILED',
  INSUFFICIENT_PROFILE:    'INSUFFICIENT_PROFILE',

  EXTERNAL_SERVICE_ERROR:  'EXTERNAL_SERVICE_ERROR',
  PAYMENT_REQUIRED:        'PAYMENT_REQUIRED',
  QUOTA_EXCEEDED:          'QUOTA_EXCEEDED',
  DUPLICATE_RECORD:        'DUPLICATE_RECORD',
});

// ─────────────────────────────────────────────────────────────────────────────
// NORMALIZERS
// ─────────────────────────────────────────────────────────────────────────────

function normalizeExternalError(err) {
  // FIX: Handle multer errors — previously fell through to 500 because
  // MulterError has no statusCode and is not an AppError instance.
  // multer must be required lazily to avoid circular-dep at module load.
  try {
    const multer = require('multer');
    if (err instanceof multer.MulterError) {
      const msgMap = {
        LIMIT_FILE_SIZE:      'File too large. Maximum size is 10 MB.',
        LIMIT_UNEXPECTED_FILE: err.message || 'Unsupported file type.',
        LIMIT_FILE_COUNT:     'Too many files. Upload one file at a time.',
      };
      return new AppError(
        msgMap[err.code] || `Upload error: ${err.message}`,
        400,
        { multerCode: err.code },
        ErrorCodes.VALIDATION_ERROR
      );
    }
  } catch (_) { /* multer not installed — skip */ }

  const codeMap = {
    'not-found':          { status: 404, code: ErrorCodes.NOT_FOUND },
    'permission-denied':  { status: 403, code: ErrorCodes.FORBIDDEN },
    'unauthenticated':    { status: 401, code: ErrorCodes.UNAUTHORIZED },
    'resource-exhausted': { status: 429, code: ErrorCodes.RATE_LIMITED },
    'invalid-argument':   { status: 400, code: ErrorCodes.VALIDATION_ERROR },
  };

  if (err?.code && codeMap[err.code]) {
    const mapped = codeMap[err.code];
    return new AppError(err.message || 'External error', mapped.status, null, mapped.code);
  }

  return null;
}

function normalizeValidationError(err) {
  if (typeof err.array === 'function') {
    const errors = err.array();

    return new AppError(
      'Request validation failed',
      400,
      {
        fields: errors.map((e) => ({
          field:   e.path,
          message: e.msg,
          value:   e.value,
        })),
      },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// REQUEST ID (Correlation-aligned)
// ─────────────────────────────────────────────────────────────────────────────

function getRequestId(req) {
  return (
    req.correlationId ||
    req.headers?.['x-correlation-id'] ||
    req.headers?.['x-request-id'] ||
    crypto.randomUUID()
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ERROR HANDLER
// ─────────────────────────────────────────────────────────────────────────────

const errorHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);

  const normalizedErr = normalizeExternalError(err) || normalizeValidationError(err);
  const resolvedErr   = normalizedErr || err || {};

  const statusCode    = resolvedErr.statusCode || 500;
  const isOperational = resolvedErr.isOperational === true;
  const requestId     = getRequestId(req);

  const logPayload = {
    requestId,
    correlationId: req.correlationId,
    userId:        req.user?.id || req.user?.uid || null,
    method:        req.method,
    url:           req.originalUrl,
    statusCode,
    errorCode:     resolvedErr.errorCode,
    duration_ms:   req.requestStart
      ? Number((Number(process.hrtime.bigint() - req.requestStart) / 1e6).toFixed(2))
      : null,
    message: resolvedErr.message || 'Unknown error',
  };

  if (statusCode >= 500 || !isOperational) {
    logPayload.stack = err?.stack;
    logger.error('[ErrorHandler] Unhandled Error', logPayload);

    sendAlert({
      message:   `${statusCode} error: ${resolvedErr.message || 'Unknown error'}`,
      severity:  isOperational ? SEVERITY.HIGH : SEVERITY.CRITICAL,
      error:     err,
      alertKey:  `500:${req.method}:${req.path}`,
      context: {
        requestId,
        correlationId: req.correlationId ?? null,
        userId:        req.user?.id ?? null,
        statusCode,
        errorCode:     resolvedErr.errorCode ?? null,
        path:          req.originalUrl,
      },
    }).catch(() => {});
  } else {
    logger.warn('[ErrorHandler] Operational Error', logPayload);
  }

  const isDev = process.env.NODE_ENV === 'development';

  const response = {
    success: false,
    error: {
      code:    resolvedErr.errorCode || ErrorCodes.INTERNAL_ERROR,
      message: isOperational
        ? resolvedErr.message || 'Request failed'
        : 'An unexpected internal error occurred. Please try again.',
    },

    ...(resolvedErr.userMessage   && { userMessage:         resolvedErr.userMessage }),
    ...(resolvedErr.retryAfterSeconds && { retryAfterSeconds: resolvedErr.retryAfterSeconds }),
    ...(resolvedErr.details        && { details:             resolvedErr.details }),
    ...(isDev                      && { stack:               err?.stack }),

    requestId,
    timestamp: new Date().toISOString(),
  };

  return res.status(statusCode).json(response);
};

// ─────────────────────────────────────────────────────────────────────────────
// 404 HANDLER
// ─────────────────────────────────────────────────────────────────────────────

const notFoundHandler = (req, res, next) => {
  logger.warn('[Telemetry] Route not found', {
    requestId:     getRequestId(req),
    correlationId: req.correlationId || null,
    method:        req.method,
    url:           req.originalUrl,
  });

  next(new AppError(
    `Endpoint not found: ${req.method} ${req.originalUrl}`,
    404,
    null,
    ErrorCodes.NOT_FOUND
  ));
};

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  errorHandler,
  notFoundHandler,
  AppError,
  ErrorCodes,
};