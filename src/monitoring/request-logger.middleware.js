'use strict';

/**
 * Production-grade request logger (core app)
 */

let logger;
try {
  logger = require('../utils/logger');
} catch {
  logger = {
    info: console.log,
    warn: console.warn,
    error: console.error,
  };
}

const { recordRequest } = require('./metrics');

const SLOW_REQUEST_THRESHOLD_MS = Number(
  process.env.SLOW_REQUEST_THRESHOLD_MS ?? 2000
);

const START_TIME = Symbol('startTime');

/* ---------------- HELPERS ---------------- */

function normalizeRoute(req) {
  const path =
    req.route?.path ||
    req.path ||
    req.originalUrl?.split('?')[0] ||
    'unknown';

  return `${req.method} ${path}`;
}

function getUserId(req) {
  return (
    req.user?.id ||
    req.user?.uid ||
    req.user?.user_id ||
    null
  );
}

/* ---------------- MIDDLEWARE ---------------- */

function requestLoggerMiddleware(req, res, next) {
  // attach high-resolution timer safely
  if (!req[START_TIME]) {
    req[START_TIME] = process.hrtime.bigint();
  }

  req.requestStart = req[START_TIME];

  let completed = false;

  res.once('finish', () => {
    completed = true;

    const durationMs =
      Number(process.hrtime.bigint() - req[START_TIME]) / 1e6;

    const statusCode = res.statusCode;
    const route = normalizeRoute(req);
    const userId = getUserId(req);

    /* -------- SUMMARY -------- */

    const summary = [
      '[HTTP]',
      req.method,
      route,
      statusCode,
      `${durationMs.toFixed(1)}ms`,
      userId ? `user=${userId}` : null,
    ]
      .filter(Boolean)
      .join(' ');

    const level =
      statusCode >= 500
        ? 'error'
        : statusCode >= 400
        ? 'warn'
        : 'info';

    logger[level](summary, {
      requestId: req.requestId ?? null,
      correlationId: req.correlationId ?? null,
      route,
      method: req.method,
      path: req.originalUrl || req.path,
      statusCode,
      durationMs: Number(durationMs.toFixed(2)),
      userId,
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
      contentLength: Number(res.getHeader('content-length') || 0),
      requestSize: Number(req.headers['content-length'] || 0),
      slow: durationMs >= SLOW_REQUEST_THRESHOLD_MS,
    });

    /* -------- METRICS -------- */

    recordRequest({
      route,
      durationMs: Number(durationMs.toFixed(2)),
      statusCode,
    });

    /* -------- SLOW REQUEST LOG -------- */

    if (durationMs >= SLOW_REQUEST_THRESHOLD_MS) {
      logger.warn('[Metrics] Slow request detected', {
        route,
        durationMs,
        threshold: SLOW_REQUEST_THRESHOLD_MS,
      });
    }
  });

  res.once('close', () => {
    if (!completed) {
      logger.warn('[HTTP] Request aborted', {
        requestId: req.requestId ?? null,
        correlationId: req.correlationId ?? null,
        method: req.method,
        path: req.originalUrl || req.path,
        userId: getUserId(req),
        ip: req.ip,
      });
    }
  });

  return next();
}

module.exports = { requestLoggerMiddleware };