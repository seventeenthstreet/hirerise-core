'use strict';

/**
 * Central error handler — production hardened
 */

const { logger }                          = require('../../shared/logger/index.js');
const { sendAlert, SEVERITY }             = require('../../shared/monitoring/alerts.js');
const { sanitizeBody, sanitizeHeaders }   = require('../../shared/monitoring/sanitize.js');

const DEFAULT_ERROR_CODE = 'INTERNAL_ERROR';
const DEFAULT_MESSAGE    = 'Unexpected error';

const ErrorCodes = {
  INTERNAL_ERROR:    'INTERNAL_ERROR',
  NOT_FOUND:         'NOT_FOUND',
  UNAUTHORIZED:      'UNAUTHORIZED',
  FORBIDDEN:         'FORBIDDEN',
  VALIDATION_ERROR:  'VALIDATION_ERROR',
  BAD_REQUEST:       'BAD_REQUEST',
  CONFLICT:          'CONFLICT',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
};

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

/* ---------------- 404 HANDLER ---------------- */

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

/* ---------------- ERROR HANDLER ---------------- */

function errorHandler(err, req, res, next) {
  try {
    const prod      = isProduction();
    const requestId = req?.requestId ?? null;

    const statusCode = normalizeStatusCode(err);
    const safeError  = serializeError(err, !prod);

    const userId =
      req?.user?.id ||
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
    // ultimate fallback — never crash the process
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

/* ---------------- APP ERROR ---------------- */

class AppError extends Error {
  // FIX (WP-ERR-01): two incompatible call conventions exist for this
  // constructor across the codebase:
  //   (message, statusCode:number, metadata:object, code:string)  — majority,
  //     used by resume/salary/careerGraph/admin/careerHealthIndex etc.
  //   (message, code:string, statusCode:number, metadata:object)  — minority,
  //     used by roles.service/onboarding.careerReport/userDirection etc.
  // The previous signature only matched the minority convention, so every
  // majority-style call passed its metadata object where a numeric statusCode
  // was expected. normalizeStatusCode() then silently fell back to 500 for
  // ALL of those — turning intended 404/400/422 responses into 500s (e.g.
  // GET /api/v1/career-health, GET /api/v1/career-opportunities/score).
  // Detecting the argument shape at the single construction point fixes
  // every call site without having to touch ~100 call sites individually.
  constructor(message, a, b, c) {
    super(message ?? DEFAULT_MESSAGE);

    let statusCode;
    let metadata;
    let code;

    if (typeof a === 'number') {
      // (message, statusCode, metadata, code)
      statusCode = a;
      metadata   = b ?? null;
      code       = c ?? 'APP_ERROR';
    } else {
      // (message, code, statusCode, metadata)
      code       = a ?? 'APP_ERROR';
      statusCode = typeof b === 'number' ? b : 400;
      metadata   = c ?? null;
    }

    this.name          = 'AppError';
    this.code          = code;
    this.statusCode    = normalizeStatusCode({ statusCode });
    this.isOperational = true;
    this.metadata      = metadata;
    Error.captureStackTrace?.(this, AppError);
  }

  static badRequest(message, code = 'BAD_REQUEST', meta) {
    return new AppError(message || 'Bad request', 400, meta, code);
  }

  static unauthorized(message, code = 'UNAUTHORIZED', meta) {
    return new AppError(message || 'Unauthorized', 401, meta, code);
  }

  static forbidden(message, code = 'FORBIDDEN', meta) {
    return new AppError(message || 'Forbidden', 403, meta, code);
  }

  static notFound(message, code = 'NOT_FOUND', meta) {
    return new AppError(message || 'Resource not found', 404, meta, code);
  }

  static conflict(message, code = 'CONFLICT', meta) {
    return new AppError(message || 'Conflict', 409, meta, code);
  }
}

/* ---------------- EXPORTS ---------------- */

module.exports = { errorHandler, notFoundHandler, AppError, ErrorCodes };