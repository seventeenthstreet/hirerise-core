'use strict';

/**
 * api-service/src/middleware/request-logger.middleware.js
 *
 * Enhanced with:
 *   - HrTime attached to req for metrics
 *   - Performance metrics integration
 *   - Formatted log line: [HTTP] GET /path 200 45ms user=123
 */

import { randomUUID } from 'crypto';
import { logger } from '../../../shared/logger/index.js';
import { recordRequest } from '../../../shared/monitoring/metrics.js';

const MAX_REQUEST_ID_LENGTH = 100;

function normalizeRequestId(headerValue) {
  if (typeof headerValue !== 'string') return randomUUID();
  const trimmed = headerValue.trim();
  if (!trimmed || trimmed.length > MAX_REQUEST_ID_LENGTH) return randomUUID();
  return trimmed;
}

function normalizeRoute(req) {
  const path = req.route?.path ?? req.path ?? req.originalUrl ?? 'unknown';
  return `${req.method} ${path}`;
}

// Request Logger Middleware
export function requestLogger(req, res, next) {
  const requestId = normalizeRequestId(req.headers['x-request-id']);
  const startHrTime = process.hrtime.bigint();

  req.requestId = requestId;
  req._startHrTime = startHrTime; // expose for metrics middleware
  res.setHeader('X-Request-ID', requestId);

  let completed = false;

  res.once('finish', () => {
    completed = true;
    const durationMs = Number(process.hrtime.bigint() - startHrTime) / 1e6;
    logRequest(req, res, durationMs);

    // Feed metrics
    recordRequest({
      route: normalizeRoute(req),
      durationMs: Number(durationMs.toFixed(2)),
      statusCode: res.statusCode,
    });
  });

  res.once('close', () => {
    if (!completed) {
      logger.warn('HTTP request aborted', {
        requestId,
        method: req.method,
        path: req.originalUrl || req.path,
        userId: req.user?.uid ?? null,
        ip: req.ip,
      });
    }
  });

  return next();
}

// Helpers
function logRequest(req, res, durationMs) {
  const userId = req.user?.uid ?? null;
  const level =
    res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

  // Formatted one-liner: [HTTP] GET /users/me 200 45ms user=123
  const summary = [
    `[HTTP]`,
    req.method,
    req.originalUrl || req.path,
    res.statusCode,
    `${durationMs.toFixed(1)}ms`,
    userId ? `user=${userId}` : null,
  ]
    .filter(Boolean)
    .join(' ');

  logger[level](summary, {
    requestId: req.requestId,
    method: req.method,
    path: req.originalUrl || req.path,
    statusCode: res.statusCode,
    durationMs: Number(durationMs.toFixed(2)),
    contentLength: Number(res.getHeader('content-length') ?? 0),
    requestSize: Number(req.headers['content-length'] ?? 0),
    userAgent: req.headers['user-agent'] ?? null,
    userId,
    ip: req.ip,
  });
}