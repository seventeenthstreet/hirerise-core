'use strict';

/**
 * Central error handler — production hardened
 */

import { logger } from '../../../shared/logger/index.js';
import { sendAlert, SEVERITY } from '../../../shared/monitoring/alerts.js';
import { sanitizeBody, sanitizeHeaders } from '../../../shared/monitoring/sanitize.js';

const DEFAULT_ERROR_CODE = 'INTERNAL_ERROR';
const DEFAULT_MESSAGE = 'Unexpected error';

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

export function errorHandler(err, req, res, next) {
  try {
    const prod = isProduction();
    const requestId = req?.requestId ?? null;

    const statusCode = normalizeStatusCode(err);
    const safeError = serializeError(err, !prod);

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
      method: req?.method,
      path: req?.path,
      userId,
      statusCode,
      errorCode: safeError.error,
      errorType: err?.constructor?.name ?? 'UnknownError',
      message: safeError.message,
      isOperational: err?.isOperational ?? false,
      headers: sanitizeHeaders(req?.headers),
      body,
      ...(prod ? {} : { stack: err?.stack }),
    });

    if (statusCode >= 500) {
      const isOperational = err?.isOperational === true;

      sendAlert({
        message: `${statusCode} error on ${route}`,
        severity: isOperational ? SEVERITY.HIGH : SEVERITY.CRITICAL,
        error: err,
        alertKey: `500:${route}:${safeError.error}`,
        context: { requestId, userId, statusCode },
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
      error: safeError.error,
      message: responseMessage,
      requestId,
      timestamp: new Date().toISOString(),
      ...(prod ? {} : safeError.stack ? { stack: safeError.stack } : {}),
    });
  } catch (handlerError) {
    // ultimate fallback (never crash)
    console.error('CRITICAL: error handler failed', handlerError);

    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Critical error handler failure',
      timestamp: new Date().toISOString(),
    });
  }
}

/* ---------------- APP ERROR ---------------- */

export class AppError extends Error {
  constructor(message, code = 'APP_ERROR', statusCode = 400, metadata = null) {
    super(message ?? DEFAULT_MESSAGE);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = normalizeStatusCode({ statusCode });
    this.isOperational = true;
    this.metadata = metadata;
    Error.captureStackTrace?.(this, AppError);
  }

  static badRequest(message, code = 'BAD_REQUEST', meta) {
    return new AppError(message || 'Bad request', code, 400, meta);
  }

  static unauthorized(message, code = 'UNAUTHORIZED', meta) {
    return new AppError(message || 'Unauthorized', code, 401, meta);
  }

  static forbidden(message, code = 'FORBIDDEN', meta) {
    return new AppError(message || 'Forbidden', code, 403, meta);
  }

  static notFound(message, code = 'NOT_FOUND', meta) {
    return new AppError(message || 'Resource not found', code, 404, meta);
  }

  static conflict(message, code = 'CONFLICT', meta) {
    return new AppError(message || 'Conflict', code, 409, meta);
  }
}