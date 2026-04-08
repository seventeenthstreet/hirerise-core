'use strict';

import { randomUUID } from 'crypto';
import { logger } from '../../../shared/logger/index.js';

const MAX_REQUEST_ID_LENGTH = 100;

function normalizeRequestId(headerValue) {
  if (typeof headerValue !== 'string') {
    return randomUUID();
  }

  const trimmed = headerValue.trim();

  if (!trimmed || trimmed.length > MAX_REQUEST_ID_LENGTH) {
    return randomUUID();
  }

  return trimmed;
}

// ─────────────────────────────────────────────────────────────────────────────
// REQUEST LOGGER
// ─────────────────────────────────────────────────────────────────────────────

export function requestLogger(req, res, next) {
  const requestId = normalizeRequestId(req.headers['x-request-id']);
  const startHrTime = process.hrtime.bigint();

  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);

  let completed = false;

  res.once('finish', () => {
    completed = true;
    logRequest(req, res, startHrTime);
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

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function logRequest(req, res, startHrTime) {
  const durationMs = Number(process.hrtime.bigint() - startHrTime) / 1e6;

  const level =
    res.statusCode >= 500
      ? 'error'
      : res.statusCode >= 400
      ? 'warn'
      : 'info';

  logger[level]('HTTP request completed', {
    requestId: req.requestId,
    method: req.method,
    path: req.originalUrl || req.path,
    statusCode: res.statusCode,
    durationMs: Number(durationMs.toFixed(2)),
    contentLength: Number(res.getHeader('content-length') ?? 0),
    requestSize: Number(req.headers['content-length'] ?? 0),
    userAgent: req.headers['user-agent'] ?? null,
    userId: req.user?.uid ?? null,
    ip: req.ip,
  });
}