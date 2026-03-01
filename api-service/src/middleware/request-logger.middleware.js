import { randomUUID } from 'crypto';
import { logger } from '../../../shared/logger/index.js';

// ─── Request Logger ───────────────────────────────────────────────────────────

export function requestLogger(req, res, next) {
  const requestId = req.headers['x-request-id'] ?? randomUUID();
  const startMs = Date.now();

  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);

  res.on('finish', () => {
    const durationMs = Date.now() - startMs;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

    logger[level]('HTTP request completed', {
      requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs,
      contentLength: res.getHeader('content-length') ?? 0,
      userAgent: req.headers['user-agent'],
      userId: req.user?.uid ?? null,
      ip: req.ip,
    });
  });

  next();
}

// ─── Error Handler ────────────────────────────────────────────────────────────

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
