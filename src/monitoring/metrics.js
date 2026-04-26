'use strict';

/**
 * Production-grade metrics system (core app)
 */

let logger;
try {
  logger = require('../utils/logger');
} catch {
  logger = {
    debug: () => {},
    info: console.log,
    warn: console.warn,
    error: console.error,
  };
}

const { sendAlert } = require('./alerts');

/* ---------------- CONFIG ---------------- */

const SLOW_REQUEST_THRESHOLD_MS = Number(process.env.SLOW_REQUEST_THRESHOLD_MS ?? 2000);
const METRICS_WINDOW_SIZE = Number(process.env.METRICS_WINDOW_SIZE ?? 200);
const MAX_ROUTES = Number(process.env.MAX_METRIC_ROUTES ?? 200);

const START_TIME = Symbol('startTime');

/* ---------------- STORAGE ---------------- */

const routeMetrics = new Map();

const globalCounters = {
  totalRequests: 0,
  totalErrors: 0,
  totalSlowRequests: 0,
  startedAt: Date.now(),
};

/* ---------------- HELPERS ---------------- */

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function normalizeRoute(req) {
  const path =
    req.route?.path ||
    req.path ||
    req.originalUrl?.split('?')[0] ||
    'unknown';

  return `${req.method} ${path}`;
}

function getOrCreate(route) {
  if (!routeMetrics.has(route)) {
    if (routeMetrics.size >= MAX_ROUTES) {
      const firstKey = routeMetrics.keys().next().value;
      routeMetrics.delete(firstKey);
    }

    routeMetrics.set(route, {
      times: [],
      errors: 0,
      total: 0,
      slowCount: 0,
    });
  }

  return routeMetrics.get(route);
}

/* ---------------- RECORD REQUEST ---------------- */

function recordRequest({ route, durationMs, statusCode }) {
  const isError = statusCode >= 500;
  const isSlow = durationMs >= SLOW_REQUEST_THRESHOLD_MS;

  globalCounters.totalRequests++;
  if (isError) globalCounters.totalErrors++;
  if (isSlow) globalCounters.totalSlowRequests++;

  const m = getOrCreate(route);

  m.total++;
  if (isError) m.errors++;
  if (isSlow) m.slowCount++;

  m.times.push(durationMs);

  if (m.times.length > METRICS_WINDOW_SIZE) {
    m.times.shift();
  }

  /* ---------- LOGGING ---------- */

  if (isSlow) {
    logger.warn('[Metrics] Slow request', {
      route,
      durationMs,
      statusCode,
    });
  }

  /* ---------- ALERTING ---------- */

  if (isError) {
    sendAlert({
      message: 'API error detected',
      severity: 'high',
      context: { route, statusCode },
      alertKey: `api_error:${route}`,
    }).catch(() => {});
  }
}

/* ---------------- SNAPSHOT ---------------- */

function getMetricsSnapshot() {
  const routes = {};

  for (const [route, m] of routeMetrics.entries()) {
    const sample =
      m.times.length > 50
        ? m.times.slice(-50)
        : m.times;

    const sorted = [...sample].sort((a, b) => a - b);

    routes[route] = {
      total: m.total,
      errors: m.errors,
      slowRequests: m.slowCount,
      errorRate: m.total > 0 ? Number((m.errors / m.total).toFixed(4)) : 0,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      avgMs: sorted.length
        ? Number((sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(2))
        : 0,
    };
  }

  return {
    uptime: Math.floor((Date.now() - globalCounters.startedAt) / 1000),
    global: { ...globalCounters },
    routes,
    slowRequestThresholdMs: SLOW_REQUEST_THRESHOLD_MS,
    collectedAt: new Date().toISOString(),
  };
}

/* ---------------- QUERY TRACKING ---------------- */

async function trackQuery(label, queryFn) {
  const start = process.hrtime.bigint();

  try {
    const result = await queryFn();
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;

    if (durationMs >= SLOW_REQUEST_THRESHOLD_MS) {
      logger.warn('[Metrics] Slow query', { label, durationMs });
    }

    return result;
  } catch (err) {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;

    logger.error('[Metrics] Query failed', {
      label,
      durationMs,
      error: err.message,
    });

    sendAlert({
      message: 'Database query failed',
      severity: 'critical',
      context: { label },
      error: err,
      alertKey: `db_error:${label}`,
    }).catch(() => {});

    throw err;
  }
}

/* ---------------- MIDDLEWARE ---------------- */

function requestMetricsMiddleware(req, res, next) {
  req[START_TIME] = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs =
      Number(process.hrtime.bigint() - req[START_TIME]) / 1e6;

    recordRequest({
      route: normalizeRoute(req),
      durationMs: Number(durationMs.toFixed(2)),
      statusCode: res.statusCode,
    });
  });

  return next();
}

module.exports = {
  recordRequest,
  getMetricsSnapshot,
  trackQuery,
  requestMetricsMiddleware,
  SLOW_REQUEST_THRESHOLD_MS,
};