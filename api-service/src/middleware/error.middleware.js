'use strict';

import { logger } from '../../../shared/logger/index.js';

const DEFAULT_ERROR_CODE = 'INTERNAL_ERROR';
const DEFAULT_MESSAGE = 'Unexpected error';

function getTimestamp() {
  return new Date().toISOString();
}

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
// CENTRAL ERROR HANDLER
// ─────────────────────────────────────────────────────────────────────────────

export function errorHandler(err, req, res, next) {
  const prod = isProduction();
  const requestId = req?.requestId ?? null;
  const statusCode = normalizeStatusCode(err);
  const safeError = serializeError(err, !prod);

  logger.error('Unhandled request error', {
    requestId,
    method: req?.method,
    path: req?.path,
    userId: req?.user?.uid ?? null,
    statusCode,
    errorCode: safeError.error,
    errorType: err?.constructor?.name ?? 'UnknownError',
    message: safeError.message,
    ...(prod ? {} : { stack: err?.stack }),
  });

  if (res.headersSent) {
    return next(err);
  }

  const responseMessage =
    prod && statusCode >= 500 ? 'Internal server error' : safeError.message;

  return res.status(statusCode).json({
    error: safeError.error,
    message: responseMessage,
    requestId,
    timestamp: getTimestamp(),
    ...(prod ? {} : safeError.stack ? { stack: safeError.stack } : {}),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// APP ERROR CLASS
// ─────────────────────────────────────────────────────────────────────────────

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
