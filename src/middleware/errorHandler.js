/**
 * errorHandler.js — Centralized Error Handling Middleware
 *
 * Design principles:
 *   - One place to intercept ALL thrown errors in the application
 *   - Distinguish between operational errors (safe to expose) and
 *     programmer errors (should never reach the client)
 *   - Never leak stack traces or internal paths to production clients
 *   - Provide a consistent error response envelope across all endpoints
 *
 * Usage:
 *   throw new AppError('Role not found', 404);
 *   throw new AppError('Invalid role transition', 422, { from: 'L1', to: 'L5' });
 */

'use strict';

const logger = require('../utils/logger');

// ── AppError ──────────────────────────────────────────────────────────────────
/**
 * Operational error class for known, anticipated failure conditions.
 * These are errors that have a meaningful HTTP status and a message
 * safe to surface to API consumers.
 *
 * @param {string}  message     - Human-readable description safe for clients
 * @param {number}  statusCode  - HTTP status code (4xx or 5xx)
 * @param {object}  [details]   - Optional structured extra context
 * @param {string}  [errorCode] - Optional machine-readable code, e.g. "ROLE_NOT_FOUND"
 */
class AppError extends Error {
  constructor(message, statusCode = 500, details = null, errorCode = null) {
    super(message);
    this.name        = 'AppError';
    this.statusCode  = statusCode;
    this.details     = details;
    this.errorCode   = errorCode;
    this.isOperational = true;

    // Capture proper stack trace, excluding this constructor frame
    Error.captureStackTrace(this, this.constructor);
  }
}

// ── Error code registry ───────────────────────────────────────────────────────
// Centralizing codes prevents client-facing strings from diverging across
// services. Frontend engineers match on these codes, not messages.
const ErrorCodes = {
  // General
  INTERNAL_ERROR:          'INTERNAL_ERROR',
  NOT_FOUND:               'NOT_FOUND',
  VALIDATION_ERROR:        'VALIDATION_ERROR',
  RATE_LIMITED:            'RATE_LIMITED',
  UNAUTHORIZED:            'UNAUTHORIZED',
  FORBIDDEN:               'FORBIDDEN',

  // Domain-specific
  ROLE_NOT_FOUND:          'ROLE_NOT_FOUND',
  SALARY_BAND_NOT_FOUND:   'SALARY_BAND_NOT_FOUND',
  INVALID_EXPERIENCE:      'INVALID_EXPERIENCE',
  SKILL_DATA_NOT_FOUND:    'SKILL_DATA_NOT_FOUND',
  CAREER_PATH_NOT_FOUND:   'CAREER_PATH_NOT_FOUND',
  JD_PARSE_FAILED:          'JD_PARSE_FAILED',
  INSUFFICIENT_PROFILE:     'INSUFFICIENT_PROFILE',
  EXTERNAL_SERVICE_ERROR:   'EXTERNAL_SERVICE_ERROR',
  PAYMENT_REQUIRED:         'PAYMENT_REQUIRED',
  QUOTA_EXCEEDED:           'QUOTA_EXCEEDED',
  JD_PARSE_FAILED:         'JD_PARSE_FAILED',
  INSUFFICIENT_PROFILE:    'INSUFFICIENT_PROFILE',
};

// ── Firestore error normalizer ─────────────────────────────────────────────────
// Firebase Admin SDK throws non-standard error objects. We normalize them
// so the central handler produces consistent responses.
const normalizeFirebaseError = (err) => {
  const codeMap = {
    'not-found':         { status: 404, code: ErrorCodes.NOT_FOUND },
    'permission-denied': { status: 403, code: ErrorCodes.FORBIDDEN },
    'unauthenticated':   { status: 401, code: ErrorCodes.UNAUTHORIZED },
    'resource-exhausted':{ status: 429, code: ErrorCodes.RATE_LIMITED },
    'invalid-argument':  { status: 400, code: ErrorCodes.VALIDATION_ERROR },
  };

  if (err.code && codeMap[err.code]) {
    const mapped = codeMap[err.code];
    return new AppError(err.message, mapped.status, null, mapped.code);
  }

  return null; // Not a recognized Firebase error — fall through to generic handler
};

// ── Validation error normalizer (express-validator) ───────────────────────────
const normalizeValidationError = (err) => {
  // express-validator attaches a structured errors array
  if (Array.isArray(err.array)) {
    const errors = err.array();
    return new AppError(
      'Request validation failed',
      400,
      { fields: errors.map(e => ({ field: e.path, message: e.msg, value: e.value })) },
      ErrorCodes.VALIDATION_ERROR
    );
  }
  return null;
};

// ── Main error handler middleware ─────────────────────────────────────────────
/**
 * Express error handler — must have exactly 4 parameters for Express to
 * recognize it as an error-handling middleware. Place LAST in middleware chain.
 */
const errorHandler = (err, req, res, next) => { // eslint-disable-line no-unused-vars
  // Try Firebase normalization first
  let normalizedErr = normalizeFirebaseError(err);

  // Then try validation normalization
  if (!normalizedErr) {
    normalizedErr = normalizeValidationError(err);
  }

  // Fall back to the raw error
  const resolvedErr = normalizedErr || err;

  const statusCode = resolvedErr.statusCode || 500;
  const isOperational = resolvedErr.isOperational === true;

  // ── Logging ────────────────────────────────────────────────────────────────
  // Programmer errors (5xx, non-operational) need full stack traces.
  // Operational errors (4xx, business logic) only need summary.
  const logPayload = {
    requestId: req.headers['x-request-id'],
    method:    req.method,
    url:       req.originalUrl,
    statusCode,
    errorCode: resolvedErr.errorCode,
    message:   resolvedErr.message,
  };

  if (statusCode >= 500 || !isOperational) {
    logPayload.stack = err.stack;
    logger.error('[ErrorHandler] Unhandled Error', logPayload);
  } else {
    logger.warn('[ErrorHandler] Operational Error', logPayload);
  }

  // ── Response envelope ──────────────────────────────────────────────────────
  const isDev = process.env.NODE_ENV === 'development';

  const response = {
    success:   false,
    errorCode: resolvedErr.errorCode || ErrorCodes.INTERNAL_ERROR,
    message:   isOperational
      ? resolvedErr.message
      : 'An unexpected internal error occurred. Please try again.',
    ...(resolvedErr.details && { details: resolvedErr.details }),
    ...(isDev && { stack: err.stack }), // Only expose stack in dev
    timestamp: new Date().toISOString(),
  };

  res.status(statusCode).json(response);
};

// ── 404 handler ────────────────────────────────────────────────────────────────
const notFoundHandler = (req, res, next) => {
  next(new AppError(
    `Endpoint not found: ${req.method} ${req.originalUrl}`,
    404,
    null,
    ErrorCodes.NOT_FOUND
  ));
};

module.exports = {
  errorHandler,
  notFoundHandler,
  AppError,
  ErrorCodes,
};

// ── Additional error codes added for gap remediation ─────────────────────────
// (appended — existing codes unchanged)
