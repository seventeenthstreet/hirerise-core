'use strict';

/**
 * shared/monitoring/metrics.js
 * Production-ready performance metrics system
 */

const { logger } = require('../logger/index.js');
const { sendAlert } = require('./alerts');

const SLOW_REQUEST_THRESHOLD_MS = Number(
  process.env.SLOW_REQUEST_THRESHOLD_MS ?? 2000
);

const METRICS_WINDOW_SIZE = Number(
  process.env.METRICS_WINDOW_SIZE ?? 200
);

const MAX_ROUTES = Number(process.env.MAX_METRIC_ROUTES ?? 200);

/* ---------------- INTERNAL STATE ---------------- */

const routeMetrics = new Map();

const globalCounters = {
  totalRequests: 0,
  totalErrors: 0,
  totalSlowRequests: 0,
  startedAt: Date.now(),
};

// safer than string key
const START_TIME = Symbol('startTime');

/* ---------------- HELPERS ---------------- */

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function normalizeRoute(req) {
  // prefer Express route definition (safe)
  if (req.route?.path) {
    return `${req.method} ${req.route.path}`;
  }

  // fallback — strip query params
  const path = (req.path || req.originalUrl || 'unknown')
    .split('?')[0];

  return `${req.method} ${path}`;
}

function getOrCreate(route) {
  if (!routeMetrics.has(route)) {
    // enforce memory cap
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
      threshold: SLOW_REQUEST_THRESHOLD_MS,
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
    // avoid heavy sort for very large arrays
    const sorted =
      m.times.length > 50
        ? [...m.times.slice(-50)].sort((a, b) => a - b)
        : [...m.times].sort((a, b) => a - b);

    routes[route] = {
      total: m.total,
      errors: m.errors,
      slowRequests: m.slowCount,
      errorRate:
        m.total > 0
          ? Number((m.errors / m.total).toFixed(4))
          : 0,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      avgMs: sorted.length
        ? Number(
            (
              sorted.reduce((a, b) => a + b, 0) / sorted.length
            ).toFixed(2)
          )
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
    } else {
      logger.debug('[Metrics] Query completed', { label, durationMs });
    }

    return result;
  } catch (err) {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;

    logger.error('[Metrics] Query failed', {
      label,
      durationMs,
      error: err.message,
    });

    // 🔥 alert on DB/query failure
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

function attachMetrics(req, res, next) {
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

/* ---------------- OPTIONAL RESET (TESTING) ---------------- */

function resetMetrics() {
  routeMetrics.clear();
  globalCounters.totalRequests = 0;
  globalCounters.totalErrors = 0;
  globalCounters.totalSlowRequests = 0;
  globalCounters.startedAt = Date.now();
}

module.exports = {
  recordRequest,
  getMetricsSnapshot,
  trackQuery,
  attachMetrics,
  resetMetrics,
  SLOW_REQUEST_THRESHOLD_MS,
};