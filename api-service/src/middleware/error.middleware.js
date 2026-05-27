'use strict';

/**
 * api-service/src/error.middleware.js
 *
 * Central error handler — production hardened, canonical V2 envelope.
 *
 * PATCH: Restored canonical V2 error envelope shape after canonicalization
 * pass accidentally flattened it, breaking parseApiResponse on the frontend.
 *
 * Canonical V2 error shape:
 *   {
 *     success: false,
 *     error: { code, message [, stack] },
 *     meta:  { requestId, timestamp [, ...] }
 *   }
 */

const { logger }                          = require('../../../shared/logger/index.js');
const { sendAlert, SEVERITY }             = require('../../../shared/monitoring/alerts.js');
const { sanitizeBody, sanitizeHeaders }   = require('../../../shared/monitoring/sanitize.js');

const DEFAULT_ERROR_CODE = 'INTERNAL_ERROR';
const DEFAULT_MESSAGE    = 'Unexpected error';

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function normalizeStatusCode(err) {
  const statusCode = Number(err?.statusCode ?? err?.status);
  if (!Number.isInteger(statusCode)) return 500;
  if (statusCode < 400 || statusCode > 599) return 500;
  return statusCode;
}

function serializeError(err, includeStack = false) {
  return {
    error: err?.code ?? DEFAULT_ERROR_CODE,
    message: err?.message ?? DEFAULT_MESSAGE,
    ...(includeStack && err?.stack ? { stack: err.stack } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 404 HANDLER
// ─────────────────────────────────────────────────────────────────────────────

function notFoundHandler(req, res) {
  return res.status(404).json({
    success: false,
    error: {
      code:    'NOT_FOUND',
      message: `Route ${req.method} ${req.path} not found`,
    },
    meta: {
      requestId: req?.requestId ?? null,
      timestamp: new Date().toISOString(),
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CENTRAL ERROR HANDLER
// ─────────────────────────────────────────────────────────────────────────────

function errorHandler(err, req, res, next) {
  try {
    const prod      = isProduction();
    const requestId = req?.requestId ?? null;

    const statusCode = normalizeStatusCode(err);
    const safeError  = serializeError(err, !prod);

    const userId =
      req?.user?.id  ||
      req?.user?.uid ||
      req?.user?.user_id ||
      null;

    const route = `${req?.method ?? 'UNKNOWN'} ${
      req?.route?.path || req?.path || '/unknown'
    }`;

    const safeBody = sanitizeBody(req?.body);
    const body =
      safeBody && JSON.stringify(safeBody).length > 2000
        ? '[body too large]'
        : safeBody;

    logger.error('Unhandled request error', {
      requestId,
      route,
      method:        req?.method,
      path:          req?.path,
      userId,
      statusCode,
      errorCode:     safeError.error,
      errorType:     err?.constructor?.name ?? 'UnknownError',
      message:       safeError.message,
      isOperational: err?.isOperational ?? false,
      headers:       sanitizeHeaders(req?.headers),
      body,
      ...(prod ? {} : { stack: err?.stack }),
    });

    if (statusCode >= 500) {
      const isOperational = err?.isOperational === true;

      sendAlert({
        message:  `${statusCode} error on ${route}`,
        severity: isOperational ? SEVERITY.HIGH : SEVERITY.CRITICAL,
        error:    err,
        alertKey: `500:${route}:${safeError.error}`,
        context:  { requestId, userId, statusCode },
      }).catch(() => {});
    }

    if (res.headersSent) {
      return next(err);
    }

    const responseMessage =
      prod && statusCode >= 500
        ? 'Internal server error'
        : safeError.message;

    // ── CANONICAL V2 ERROR ENVELOPE ──────────────────────────────────────────
    // Must match: { success: false, error: { code, message }, meta: { ... } }
    // The previous canonicalization pass accidentally flattened this to a
    // non-canonical shape (missing success/error nesting/meta) which caused
    // parseApiResponse → makeFallbackError on the frontend.
    return res.status(statusCode).json({
      success: false,
      error: {
        code:    safeError.error,
        message: responseMessage,
        ...(safeError.stack && !prod ? { stack: safeError.stack } : {}),
      },
      meta: {
        requestId,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (handlerError) {
    // Ultimate fallback — never crash the process.
    // Also uses canonical V2 shape so the parser never chokes even here.
    console.error('CRITICAL: error handler failed', handlerError);

    return res.status(500).json({
      success: false,
      error: {
        code:    'INTERNAL_ERROR',
        message: 'Critical error handler failure',
      },
      meta: {
        timestamp: new Date().toISOString(),
      },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// APP ERROR CLASS
// ─────────────────────────────────────────────────────────────────────────────

class AppError extends Error {
  // Canonical constructor: (message, code, statusCode, metadata)
  constructor(message, code = 'APP_ERROR', statusCode = 400, metadata = null) {
    super(message ?? DEFAULT_MESSAGE);
    this.name          = 'AppError';
    this.code          = code;
    this.statusCode    = normalizeStatusCode({ statusCode });
    this.isOperational = true;
    this.metadata      = metadata;
    Error.captureStackTrace?.(this, AppError);
  }

  static badRequest(message = 'Bad request', code = 'BAD_REQUEST', metadata) {
    return new AppError(message, code, 400, metadata);
  }

  static unauthorized(message = 'Unauthorized', code = 'UNAUTHORIZED', metadata) {
    return new AppError(message, code, 401, metadata);
  }

  static forbidden(message = 'Forbidden', code = 'FORBIDDEN', metadata) {
    return new AppError(message, code, 403, metadata);
  }

  static notFound(message = 'Resource not found', code = 'NOT_FOUND', metadata) {
    return new AppError(message, code, 404, metadata);
  }

  static conflict(message = 'Conflict', code = 'CONFLICT', metadata) {
    return new AppError(message, code, 409, metadata);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ERROR CODES REGISTRY
// ─────────────────────────────────────────────────────────────────────────────

const ErrorCodes = Object.freeze({
  INTERNAL_ERROR:  'INTERNAL_ERROR',
  UNAUTHORIZED:    'UNAUTHORIZED',
  FORBIDDEN:       'FORBIDDEN',
  NOT_FOUND:       'NOT_FOUND',
  BAD_REQUEST:     'BAD_REQUEST',
  CONFLICT:        'CONFLICT',
  VALIDATION:      'VALIDATION_ERROR',
  RATE_LIMITED:    'RATE_LIMIT_EXCEEDED',
});

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = { errorHandler, notFoundHandler, AppError, ErrorCodes };