'use strict';

/**
 * errorHandler.js (Production Optimized)
 */

const logger = require('../utils/logger');
const crypto = require('crypto');

// ─────────────────────────────────────────────────────────────────────────────
// APP ERROR
// ─────────────────────────────────────────────────────────────────────────────

class AppError extends Error {
  constructor(
    message,
    statusCode = 500,
    details = null,
    errorCode = null,
    userMessage = null
  ) {
    super(message);

    this.name = 'AppError';
    this.statusCode = statusCode;
    this.details = details;
    this.errorCode = errorCode;
    this.userMessage = userMessage;
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ERROR CODES
// ─────────────────────────────────────────────────────────────────────────────

const ErrorCodes = Object.freeze({
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  CONFLICT: 'CONFLICT',

  ROLE_NOT_FOUND: 'ROLE_NOT_FOUND',
  SALARY_BAND_NOT_FOUND: 'SALARY_BAND_NOT_FOUND',
  INVALID_EXPERIENCE: 'INVALID_EXPERIENCE',
  SKILL_DATA_NOT_FOUND: 'SKILL_DATA_NOT_FOUND',
  CAREER_PATH_NOT_FOUND: 'CAREER_PATH_NOT_FOUND',
  JD_PARSE_FAILED: 'JD_PARSE_FAILED',
  INSUFFICIENT_PROFILE: 'INSUFFICIENT_PROFILE',

  EXTERNAL_SERVICE_ERROR: 'EXTERNAL_SERVICE_ERROR',
  PAYMENT_REQUIRED: 'PAYMENT_REQUIRED',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  DUPLICATE_RECORD: 'DUPLICATE_RECORD',
});

// ─────────────────────────────────────────────────────────────────────────────
// NORMALIZERS
// ─────────────────────────────────────────────────────────────────────────────

function normalizeExternalError(err) {
  const codeMap = {
    'not-found': { status: 404, code: ErrorCodes.NOT_FOUND },
    'permission-denied': { status: 403, code: ErrorCodes.FORBIDDEN },
    'unauthenticated': { status: 401, code: ErrorCodes.UNAUTHORIZED },
    'resource-exhausted': { status: 429, code: ErrorCodes.RATE_LIMITED },
    'invalid-argument': { status: 400, code: ErrorCodes.VALIDATION_ERROR },
  };

  if (err?.code && codeMap[err.code]) {
    const mapped = codeMap[err.code];
    return new AppError(
      err.message || 'External error',
      mapped.status,
      null,
      mapped.code
    );
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
        fields: errors.map(e => ({
          field: e.path,
          message: e.msg,
          value: e.value,
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
    req.correlationId || // ✅ use your correlation middleware
    req.headers['x-correlation-id'] ||
    req.headers['x-request-id'] ||
    crypto.randomUUID()
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ERROR HANDLER
// ─────────────────────────────────────────────────────────────────────────────

const errorHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);

  // Normalize
  const normalizedErr =
    normalizeExternalError(err) ||
    normalizeValidationError(err);

  const resolvedErr = normalizedErr || err || {};

  const statusCode = resolvedErr.statusCode || 500;
  const isOperational = resolvedErr.isOperational === true;

  const requestId = getRequestId(req);

  // ─── Logging ─────────────────────────────────────
  const logPayload = {
    requestId,
    correlationId: req.correlationId, // ✅ important
    userId: req.user?.uid || null,
    method: req.method,
    url: req.originalUrl,
    statusCode,
    errorCode: resolvedErr.errorCode,
    message: resolvedErr.message || 'Unknown error',
  };

  if (statusCode >= 500 || !isOperational) {
    logPayload.stack = err?.stack;
    logger.error('[ErrorHandler] Unhandled Error', logPayload);
  } else {
    logger.warn('[ErrorHandler] Operational Error', logPayload);
  }

  // ─── Response ────────────────────────────────────
  const isDev = process.env.NODE_ENV === 'development';

  const response = {
    success: false,
    error: {
      code: resolvedErr.errorCode || ErrorCodes.INTERNAL_ERROR,
      message: isOperational
        ? resolvedErr.message || 'Request failed'
        : 'An unexpected internal error occurred. Please try again.',
    },

    ...(resolvedErr.userMessage && { userMessage: resolvedErr.userMessage }),
    ...(resolvedErr.retryAfterSeconds && { retryAfterSeconds: resolvedErr.retryAfterSeconds }),
    ...(resolvedErr.details && { details: resolvedErr.details }),

    ...(isDev && { stack: err?.stack }),

    requestId,
    timestamp: new Date().toISOString(),
  };

  return res.status(statusCode).json(response);
};

// ─────────────────────────────────────────────────────────────────────────────
// 404 HANDLER
// ─────────────────────────────────────────────────────────────────────────────

const notFoundHandler = (req, res, next) => {
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