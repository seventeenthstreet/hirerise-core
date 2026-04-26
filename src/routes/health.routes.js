'use strict';

/**
 * src/routes/health.routes.js
 * HireRise PR 2 — Health + Deep Diagnostics
 *
 * Routes:
 *   GET /health        → pure liveness
 *   GET /health/deep   → dependency diagnostics
 *   GET /health/metrics → in-process performance snapshot
 *   GET /health/redis  → Redis circuit breaker + latency metrics  ← Phase 4
 */

const express = require('express');
const { getMetricsSnapshot } = require('../monitoring/metrics');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// Supabase admin client singleton
// ─────────────────────────────────────────────────────────────
let probeClient = null;

function getProbeClient() {
  if (probeClient) return probeClient;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set'
    );
  }

  probeClient = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return probeClient;
}

// ─────────────────────────────────────────────────────────────
// Probe token guard
// ─────────────────────────────────────────────────────────────
function requireProbeToken(req, res, next) {
  const expected = process.env.HEALTH_PROBE_TOKEN;
  const IS_PROD   = process.env.NODE_ENV === 'production';

  // HARDENING: In production HEALTH_PROBE_TOKEN MUST be set.
  // If the env var is missing, the deep probe returns 503 to prevent
  // exposing dependency health data on an effectively unguarded endpoint.
  if (!expected) {
    if (IS_PROD) {
      return res.status(503).json({
        error: 'Health probe not configured',
        hint:  'Set HEALTH_PROBE_TOKEN in production environment',
      });
    }
    // Non-production: allow through without token (dev convenience)
    return next();
  }

  const provided = req.headers['x-health-probe-token'];

  if (!provided || provided !== expected) {
    return res.status(401).json({
      error: 'Invalid probe token',
    });
  }

  return next();
}

// ─────────────────────────────────────────────────────────────
// Individual probes
// ─────────────────────────────────────────────────────────────
async function probeDatabase() {
  const start = Date.now();

  try {
    const { error } = await getProbeClient()
      .from('users')
      .select('id')
      .limit(1);

    if (error) throw error;

    return {
      ok: true,
      latencyMs: Date.now() - start,
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: error.message,
    };
  }
}

async function probeRedis() {
  const start = Date.now();

  try {
    const {
      getRedisStatus,
    } = require('../config/redisClient');

    const redis = getRedisStatus();

    return {
      ok: redis.connected,
      latencyMs: Date.now() - start,
      provider: redis.provider,
      backend: redis.backend,
      ...(process.env.NODE_ENV !== 'production' &&
      redis.error
        ? { error: redis.error }
        : {}),
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: error.message,
    };
  }
}

async function probeAnthropic() {
  const start = Date.now();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch('https://api.anthropic.com', {
      method: 'HEAD',
      signal: controller.signal,
    });

    clearTimeout(timeout);

    return {
      ok: response.status < 600,
      latencyMs: Date.now() - start,
      httpStatus: response.status,
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error:
        error.name === 'AbortError'
          ? 'timeout (5s)'
          : error.message,
    };
  }
}

async function probeAiQueueDepth() {
  const start = Date.now();

  try {
    const threshold = new Date(
      Date.now() - 5 * 60_000
    ).toISOString();

    const { count, error } = await getProbeClient()
      .from('ai_jobs')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending')
      .lte('created_at', threshold);

    if (error) throw error;

    const staleCount = count ?? 0;
    const ok = staleCount < 10;

    return {
      ok,
      latencyMs: Date.now() - start,
      staleJobs: staleCount,
      note: ok
        ? null
        : `${staleCount} jobs pending >5min — queue processor may be down`,
    };
  } catch (error) {
    return {
      ok: true,
      latencyMs: Date.now() - start,
      error: error.message,
      note: 'probe failed',
    };
  }
}

function probeProcess() {
  const mem = process.memoryUsage();

  return {
    ok: true,
    uptimeSeconds: Math.floor(process.uptime()),
    memoryRssMB: Math.round(mem.rss / 1_048_576),
    heapUsedMB: Math.round(mem.heapUsed / 1_048_576),
    heapTotalMB: Math.round(mem.heapTotal / 1_048_576),
    nodeVersion: process.version,
  };
}

function probeAiProviders() {
  try {
    const { getProviderHealth } = require('../services/aiRouter');
    const providers = getProviderHealth();

    const anyDown = providers.some(
      (provider) => provider.status === 'down'
    );

    return {
      ok: !anyDown,
      providers,
      note: anyDown
        ? 'One or more AI providers are in cooldown — fallback chain still active'
        : null,
    };
  } catch (error) {
    return {
      ok: true,
      providers: [],
      error: error.message,
      note: 'probe unavailable',
    };
  }
}

// ─────────────────────────────────────────────────────────────
// Phase 4 — Redis circuit breaker probe
// ─────────────────────────────────────────────────────────────

/**
 * Derives a human-readable status from singleton readiness + circuit state.
 *
 *   healthy  → ready AND circuit CLOSED
 *   degraded → ready BUT circuit HALF_OPEN, OR failure rate is high
 *   down     → not ready OR circuit OPEN
 */
function deriveRedisStatus(ready, circuitState, cbMetrics) {
  if (!ready || circuitState === 'OPEN') return 'down';
  if (circuitState === 'HALF_OPEN')      return 'degraded';

  // Healthy but with elevated failure rate (>20% of calls failed)
  const failureRate = cbMetrics.totalCalls > 0
    ? cbMetrics.failures / cbMetrics.totalCalls
    : 0;

  if (failureRate > 0.2 || cbMetrics.slowCalls > 10) return 'degraded';

  return 'healthy';
}

function probeRedisSingleton() {
  try {
    const singleton = require('../infrastructure/radis/redis.singleton');
    const ready     = singleton.isReady();
    const cb        = singleton.circuitBreaker;
    const cbMetrics = cb.getMetrics();
    const status    = deriveRedisStatus(ready, cbMetrics.state, cbMetrics);

    return {
      ok:      status !== 'down',
      status,
      ready,
      circuit: cbMetrics.state,
      metrics: {
        totalCalls:    cbMetrics.totalCalls,
        failures:      cbMetrics.failures,
        failureRate:   cbMetrics.failureRate,       // e.g. 0.83
        avgLatencyMs:  cbMetrics.avgLatencyMs,
        slowCalls:     cbMetrics.slowCalls,
        openDurationMs: cbMetrics.openDurationMs,  // ms OPEN, or null
      },
    };
  } catch (err) {
    return {
      ok:      false,
      status:  'down',
      ready:   false,
      circuit: 'UNKNOWN',
      error:   err.message,
      metrics: {
        totalCalls:     0,
        failures:       0,
        failureRate:    0,
        avgLatencyMs:   0,
        slowCalls:      0,
        openDurationMs: null,
      },
    };
  }
}

// ─────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────

/**
 * Pure liveness probe
 * Returns 200 if Node process is alive.
 */
router.get('/', (_req, res) => {
  return res.status(200).json({
    status: 'healthy',
    ts: new Date().toISOString(),
  });
});

/**
 * Deep dependency diagnostics
 */
router.get('/deep', requireProbeToken, async (req, res) => {
  const start = Date.now();

  const [database, redis, anthropic, aiQueue] =
    await Promise.all([
      probeDatabase(),
      probeRedis(),
      probeAnthropic(),
      probeAiQueueDepth(),
    ]);

  const processProbe = probeProcess();
  const aiProviders = probeAiProviders();

  const probes = {
    database,
    redis,
    anthropic,
    aiQueue,
    aiProviders,
    process: processProbe,
  };

  let status = 'healthy';

  if (!database.ok) {
    status = 'unhealthy';
  } else if (
    !redis.ok ||
    !anthropic.ok ||
    !aiQueue.ok ||
    !aiProviders.ok
  ) {
    status = 'degraded';
  }

  return res.status(status === 'unhealthy' ? 503 : 200).json({
    status,
    environment: process.env.NODE_ENV || 'unknown',
    version: process.env.APP_VERSION || 'unknown',
    durationMs: Date.now() - start,
    ts: new Date().toISOString(),
    probes,
  });
});

// ─────────────────────────────────────────────────────────────
// GET /health/metrics — In-process performance snapshot
// Protected by INTERNAL_SERVICE_TOKEN in production.
// ─────────────────────────────────────────────────────────────
router.get('/metrics', (req, res) => {
  const internalToken = process.env.INTERNAL_SERVICE_TOKEN;
  if (internalToken && process.env.NODE_ENV === 'production') {
    const provided = req.headers['x-internal-token'] || req.headers['x-health-probe-token'];
    if (provided !== internalToken) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Internal endpoint' });
    }
  }

  const mem = process.memoryUsage();
  return res.json({
    status: 'ok',
    service: 'hirerise-core',
    environment: process.env.NODE_ENV ?? 'unknown',
    memory: {
      heapUsedMb: Number((mem.heapUsed / 1024 / 1024).toFixed(2)),
      heapTotalMb: Number((mem.heapTotal / 1024 / 1024).toFixed(2)),
      rssMb: Number((mem.rss / 1024 / 1024).toFixed(2)),
    },
    ...getMetricsSnapshot(),
    ts: new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────────────────────
// GET /health/redis — Redis circuit breaker + latency metrics
//
// Secured identically to /health/metrics (INTERNAL_SERVICE_TOKEN
// in production; open in dev/test for convenience).
//
// Response shape:
// {
//   status:  "healthy" | "degraded" | "down",
//   ready:   boolean,
//   circuit: "CLOSED" | "OPEN" | "HALF_OPEN",
//   metrics: {
//     totalCalls:    number,        // safeExec invocations since boot (or last overflow reset)
//     failures:      number,        // calls that threw or timed out
//     failureRate:   number,        // failures / totalCalls, rounded to 2dp (0 when no calls)
//     avgLatencyMs:  number,        // rolling mean wall-clock latency
//     slowCalls:     number,        // calls exceeding REDIS_CB_SLOW_CALL_MS (default 200ms)
//     openDurationMs: number | null // ms since circuit entered OPEN; null when CLOSED
//   },
//   ts: ISO string
// }
//
// HTTP status codes:
//   200 — healthy or degraded (system still operating)
//   503 — down (circuit OPEN or client not ready)
// ─────────────────────────────────────────────────────────────
router.get('/redis', (req, res) => {
  // Same token guard as /health/metrics
  const internalToken = process.env.INTERNAL_SERVICE_TOKEN;
  if (internalToken && process.env.NODE_ENV === 'production') {
    const provided = req.headers['x-internal-token'] || req.headers['x-health-probe-token'];
    if (provided !== internalToken) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Internal endpoint' });
    }
  }

  const probe = probeRedisSingleton();

  return res.status(probe.status === 'down' ? 503 : 200).json({
    status:  probe.status,
    ready:   probe.ready,
    circuit: probe.circuit,
    metrics: probe.metrics,
    ...(probe.error ? { error: probe.error } : {}),
    ts: new Date().toISOString(),
  });
});

module.exports = router;