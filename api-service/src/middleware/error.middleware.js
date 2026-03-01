import { logger } from '../../../shared/logger/index.js';

export function errorHandler(err, req, res, next) {
  const requestId = req.requestId;

  logger.error('Unhandled request error', {
    err,
    requestId,
    method: req.method,
    path: req.path,
    userId: req.user?.uid ?? null,
    errorCode: err.code,
    errorType: err.constructor?.name,
  });

  if (res.headersSent) return next(err);

  const statusCode = err.statusCode ?? err.status ?? 500;
  const isProd = process.env.NODE_ENV === 'production';

  res.status(statusCode).json({
    error: err.code ?? 'INTERNAL_ERROR',
    message: isProd && statusCode === 500 ? 'Internal server error' : err.message,
    requestId,
  });
}

export class AppError extends Error {
  constructor(message, code, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.name = 'AppError';
  }
}
