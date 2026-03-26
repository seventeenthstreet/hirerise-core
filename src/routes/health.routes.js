'use strict';

/**
 * health.routes.js — PHASE 4 UPDATE (Supabase migration patch)
 *
 * CHANGES FROM PREVIOUS VERSION:
 *
 *   probeFirestore() → probeSupabase()
 *     The old probe wrote/read a document to Firestore's health_probes collection.
 *     That collection no longer exists — the database is now Supabase PostgreSQL.
 *     The probe now does a lightweight SELECT on the `users` table via the
 *     Supabase service-role client. A single-row LIMIT 1 query confirms that
 *     the DB connection, credentials, and network path are all working.
 *     The function is still called probeFirestore() internally so no callers change.
 *
 *   probeAiQueueDepth()
 *     Also updated — the old version used Timestamp.fromDate() in a Firestore
 *     .where() clause. Replaced with a plain ISO string comparison that works
 *     with Supabase's timestamptz columns via the shim's query interface.
 *
 *   All other probes (Redis, Anthropic, Process, AiProviders) are unchanged.
 *   All route paths, response shapes, and status logic are unchanged.
 *
 * @module routes/health.routes
 */

const express            = require('express');
const { createClient }   = require('@supabase/supabase-js');
const { db }             = require('../config/supabase');

const router = express.Router();

// ─── Supabase admin client (singleton) ───────────────────────────────────────

let _supabaseProbe = null;

function getProbeClient() {
  if (_supabaseProbe) return _supabaseProbe;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set');

  _supabaseProbe = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return _supabaseProbe;
}

// ─── Probe token guard ────────────────────────────────────────────────────────

function requireProbeToken(req, res, next) {
  const expected = process.env.HEALTH_PROBE_TOKEN;

  // If no token configured (dev), allow freely — ops must set this in prod
  if (!expected) return next();

  const provided = req.headers['x-health-probe-token'];
  if (!provided || provided !== expected) {
    return res.status(401).json({ error: 'Invalid probe token' });
  }
  return next();
}

// ─── Individual probes ────────────────────────────────────────────────────────

/**
 * probeFirestore()  ← name kept so route handlers need no changes
 *
 * MIGRATED: was Firestore write/read on health_probes/{id}
 * NOW:      Supabase SELECT 1 row from users table
 *
 * A successful query (even with 0 rows) confirms:
 *   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are valid
 *   - Network path to Supabase is open
 *   - PostgreSQL connection pool is healthy
 */
async function probeFirestore() {
  const start = Date.now();
  try {
    const { error } = await getProbeClient()
      .from('users')
      .select('id')
      .limit(1);

    if (error) throw new Error(error.message);

    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: err.message };
  }
}

/**
 * probeRedis()
 *
 * Uses cache manager → RedisCache.ping().
 * Falls back gracefully if Redis is not configured.
 */
async function probeRedis() {
  const start = Date.now();
  try {
    const mgr = require('../core/cache/cache.manager');
    const client = mgr.getClient();

    if (typeof client.ping === 'function') {
      return await client.ping();
    }

    // MemoryCache path — Redis not configured, report as skipped not failed
    return { ok: true, latencyMs: Date.now() - start, note: 'memory-cache (Redis not configured)' };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: err.message };
  }
}

/**
 * probeAnthropic()
 *
 * Connectivity probe — HEAD request to api.anthropic.com.
 * Does NOT send an API key or consume any tokens.
 * A 4xx response still means the endpoint is reachable (network is fine).
 */
async function probeAnthropic() {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 5000);

    const res = await fetch('https://api.anthropic.com', {
      method: 'HEAD',
      signal: controller.signal,
    });
    clearTimeout(timeout);

    // Any HTTP response (including 404/405) means TCP + TLS + DNS all work
    const reachable = res.status < 600;
    return { ok: reachable, latencyMs: Date.now() - start, httpStatus: res.status };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: err.name === 'AbortError' ? 'timeout (5s)' : err.message,
    };
  }
}

/**
 * probeAiQueueDepth()
 *
 * Counts ai_jobs pending for more than 5 minutes.
 * > 10 stale jobs = processor is likely down → degraded.
 *
 * MIGRATED: removed Timestamp.fromDate() — uses ISO string comparison
 * which works with Supabase's timestamptz columns.
 */
async function probeAiQueueDepth() {
  const start = Date.now();
  try {
    const threshold = new Date(Date.now() - 5 * 60_000).toISOString(); // 5 min ago

    const { data, error } = await getProbeClient()
      .from('ai_jobs')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending')
      .lte('created_at', threshold)
      .limit(20);

    if (error) throw new Error(error.message);

    const staleCount = data?.length ?? 0;
    const ok         = staleCount < 10;

    return {
      ok,
      latencyMs:  Date.now() - start,
      staleJobs:  staleCount,
      note: ok ? null : `${staleCount} jobs pending >5min — queue processor may be down`,
    };
  } catch (err) {
    // Queue probe failure is non-critical — don't mark system unhealthy
    return { ok: true, latencyMs: Date.now() - start, error: err.message, note: 'probe failed' };
  }
}

/**
 * probeProcess()
 *
 * Returns Node.js process vitals. No I/O — always fast.
 */
function probeProcess() {
  const mem = process.memoryUsage();
  return {
    ok:            true,
    uptimeSeconds: Math.floor(process.uptime()),
    memoryRssMB:   Math.round(mem.rss / 1_048_576),
    heapUsedMB:    Math.round(mem.heapUsed / 1_048_576),
    heapTotalMB:   Math.round(mem.heapTotal / 1_048_576),
    nodeVersion:   process.version,
  };
}

/**
 * probeAiProviders()
 *
 * Returns the current in-memory health snapshot for every AI provider.
 * Read-only — does NOT make any live API calls or consume credits.
 * A provider showing "down" is in cooldown and will auto-recover.
 */
function probeAiProviders() {
  try {
    const { getProviderHealth } = require('../services/aiRouter');
    const providers = getProviderHealth();
    const anyDown   = providers.some(function(p) { return p.status === 'down'; });
    return {
      ok:        !anyDown,
      providers: providers,
      note: anyDown
        ? 'One or more AI providers are in cooldown — fallback chain still active'
        : null,
    };
  } catch (err) {
    return { ok: true, providers: [], error: err.message, note: 'probe unavailable' };
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /health
 *
 * Public. Load balancer / Cloud Run health check.
 * Returns 200 healthy / 503 unhealthy.
 * Never blocks on slow dependencies — 2s timeout.
 */
router.get('/', async (req, res) => {
  const dbOk = await Promise.race([
    probeFirestore().then(r => r.ok),
    new Promise(resolve => setTimeout(() => resolve(false), 2000)),
  ]);

  if (dbOk) {
    return res.status(200).json({ status: 'healthy', ts: new Date().toISOString() });
  }
  return res.status(503).json({ status: 'unhealthy', ts: new Date().toISOString() });
});

/**
 * GET /health/deep
 *
 * Internal. Requires X-Health-Probe-Token.
 * Runs all probes in parallel, returns full detail.
 * Used by: synthetic monitoring, on-call runbooks, pre-deploy checks.
 */
router.get('/deep', requireProbeToken, async (req, res) => {
  const start = Date.now();

  // Run all I/O probes in parallel
  const [firestore, redis, anthropic, aiQueue] = await Promise.all([
    probeFirestore(),
    probeRedis(),
    probeAnthropic(),
    probeAiQueueDepth(),
  ]);

  const process_    = probeProcess();
  const aiProviders = probeAiProviders(); // synchronous — reads in-memory health state

  const probes = { firestore, redis, anthropic, aiQueue, aiProviders, process: process_ };

  // Determine overall status
  let status = 'healthy';
  if (!firestore.ok) {
    status = 'unhealthy'; // Cannot serve users without Supabase DB
  } else if (!redis.ok || !anthropic.ok || !aiQueue.ok || !aiProviders.ok) {
    status = 'degraded';  // Some providers are in cooldown — fallback chain still active
  }

  const httpStatus = status === 'unhealthy' ? 503 : 200;

  return res.status(httpStatus).json({
    status,
    environment: process.env.NODE_ENV || 'unknown',
    version:     process.env.APP_VERSION || 'unknown',
    durationMs:  Date.now() - start,
    ts:          new Date().toISOString(),
    probes,
  });
});

module.exports = router;









