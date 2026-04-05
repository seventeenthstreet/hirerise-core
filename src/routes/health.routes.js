'use strict';

/**
 * routes/health.routes.js
 * Supabase + dependency health probes
 */

const express = require('express');
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

  if (!expected) return next();

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
    const mgr = require('../core/cache/cache.manager');
    const client = mgr.getClient();

    if (typeof client.ping === 'function') {
      return await client.ping();
    }

    return {
      ok: true,
      latencyMs: Date.now() - start,
      note: 'memory-cache (Redis not configured)',
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
// Routes
// ─────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const dbOk = await Promise.race([
    probeDatabase().then((r) => r.ok),
    new Promise((resolve) =>
      setTimeout(() => resolve(false), 2000)
    ),
  ]);

  const ts = new Date().toISOString();

  if (dbOk) {
    return res.status(200).json({
      status: 'healthy',
      ts,
    });
  }

  return res.status(503).json({
    status: 'unhealthy',
    ts,
  });
});

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

module.exports = router;