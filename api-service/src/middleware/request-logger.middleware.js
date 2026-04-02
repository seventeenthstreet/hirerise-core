import { randomUUID } from 'crypto';
import { logger } from '../../../shared/logger/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// REQUEST LOGGER
// ─────────────────────────────────────────────────────────────────────────────

export function requestLogger(req, res, next) {
  // Sanitize incoming request ID
  let requestId = req.headers['x-request-id'];

  if (!requestId || typeof requestId !== 'string' || requestId.length > 100) {
    requestId = randomUUID();
  }

  const startMs = Date.now();

  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);

  // Handle normal completion
  res.on('finish', () => {
    logRequest(req, res, startMs);
  });

  // Handle aborted requests
  res.on('close', () => {
    if (!res.writableEnded) {
      logger.warn('HTTP request aborted', {
        requestId,
        method: req.method,
        path: req.path,
        userId: req.user?.uid ?? null,
        ip: req.ip,
      });
    }
  });

  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function logRequest(req, res, startMs) {
  const durationMs = Date.now() - startMs;

  const level =
    res.statusCode >= 500
      ? 'error'
      : res.statusCode >= 400
      ? 'warn'
      : 'info';

  logger[level]('HTTP request completed', {
    requestId: req.requestId,
    method: req.method,
    path: req.path,
    statusCode: res.statusCode,
    durationMs,
    contentLength: res.getHeader('content-length') ?? 0,
    requestSize: req.headers['content-length'] ?? 0,
    userAgent: req.headers['user-agent'],
    userId: req.user?.uid ?? null,
    ip: req.ip,
  });
}