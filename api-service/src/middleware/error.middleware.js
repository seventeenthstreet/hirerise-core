import { logger } from '../../../shared/logger/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// CENTRAL ERROR HANDLER
// ─────────────────────────────────────────────────────────────────────────────

export function errorHandler(err, req, res, next) {
  const requestId = req.requestId;
  const isProd = process.env.NODE_ENV === 'production';

  const statusCode = normalizeStatusCode(err);
  const errorCode = err.code || 'INTERNAL_ERROR';
  const message = err.message || 'Unexpected error';

  // Safe structured logging
  logger.error('Unhandled request error', {
    requestId,
    method: req.method,
    path: req.path,
    userId: req.user?.uid ?? null,
    statusCode,
    errorCode,
    errorType: err.constructor?.name,
    message,
    // Only include stack in non-prod
    ...(isProd ? {} : { stack: err.stack }),
  });

  if (res.headersSent) return next(err);

  res.status(statusCode).json({
    error: errorCode,
    message: isProd && statusCode === 500
      ? 'Internal server error'
      : message,
    requestId,
    timestamp: new Date().toISOString(),
    ...(isProd ? {} : { stack: err.stack }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function normalizeStatusCode(err) {
  const code = err.statusCode ?? err.status;
  if (typeof code !== 'number') return 500;
  if (code < 400 || code > 599) return 500;
  return code;
}

// ─────────────────────────────────────────────────────────────────────────────
// APP ERROR CLASS
// ─────────────────────────────────────────────────────────────────────────────

export class AppError extends Error {
  constructor(message, code = 'APP_ERROR', statusCode = 400) {
    super(message);

    this.code = code;
    this.statusCode = statusCode;
    this.name = 'AppError';
    this.isOperational = true;

    Error.captureStackTrace?.(this, this.constructor);
  }
}