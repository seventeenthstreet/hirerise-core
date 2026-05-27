'use strict';

/**
 * src/routes/health.routes.js  (HARDENED REPLACEMENT)
 *
 * PHASE 5 — Backend Health + Readiness
 *
 * ENDPOINTS
 * ─────────
 * GET /health   — Liveness probe (lightweight, ~1 ms).
 *                 Used by load balancers / Docker HEALTHCHECK.
 *                 Always returns 200 while the process is alive.
 *
 * GET /ready    — Readiness probe (verifies Supabase + DB connectivity).
 *                 Used by Kubernetes / Cloud Run before routing traffic.
 *                 Returns 200 when all critical services are reachable.
 *                 Returns 503 when any critical service is degraded.
 *
 * RESPONSE SHAPES
 * ───────────────
 * /health:
 *   { "ok": true, "service": "hirerise-core", "uptime": 42 }
 *
 * /ready (healthy):
 *   {
 *     "ok": true,
 *     "services": {
 *       "supabase": "up",
 *       "database": "up"
 *     },
 *     "timestamp": "2026-05-21T12:00:00.000Z",
 *     "requestId": "req_abc123"
 *   }
 *
 * /ready (degraded):
 *   {
 *     "ok": false,
 *     "services": {
 *       "supabase": "up",
 *       "database": "down"
 *     },
 *     "error": "database check failed: connection refused",
 *     "timestamp": "2026-05-21T12:00:00.000Z",
 *     "requestId": "req_abc123"
 *   }
 *
 * PHASE 2: requestId is read from the X-Request-ID header (set by
 * correlationMiddleware) and echoed in every health response so log lines
 * from probe failures can be correlated to frontend requests.
 *
 * PRODUCTION SAFETY
 * ─────────────────
 * - /health is always public (no auth required).
 * - /ready is always public — Kubernetes probes cannot send auth headers.
 * - Internal service details (memory, PID, env vars) are NEVER exposed
 *   in the default response. A ?verbose=1 + INTERNAL_SERVICE_TOKEN query
 *   guard may be added separately for internal tooling.
 * - All checks run in parallel (Promise.allSettled) with a 2-second
 *   timeout each to prevent probe timeouts from cascading.
 */

const express     = require('express');
const logger      = require('../utils/logger');

const router = express.Router();

const SERVICE_NAME          = 'hirerise-core';
const READINESS_TIMEOUT_MS  = 2_000;

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: timeout-safe promise race
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Races a promise against a deadline.
 * On timeout, resolves to { ok: false, reason: 'timeout' } rather than rejecting
 * so Promise.allSettled sees a resolved value and can still aggregate results.
 *
 * @param {Promise<*>} promise
 * @param {number}     ms
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
function withReadinessTimeout(promise, ms) {
  let timerId;
  const timeout = new Promise((resolve) => {
    timerId = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), ms);
  });
  return Promise.race([
    promise.then(() => ({ ok: true })).catch((err) => ({ ok: false, reason: err?.message ?? String(err) })),
    timeout,
  ]).finally(() => clearTimeout(timerId));
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: get request ID (Phase 2 — correlation)
// ─────────────────────────────────────────────────────────────────────────────

function getRequestId(req) {
  return req.requestId                    // set by correlationMiddleware
    ?? req.headers['x-request-id']
    ?? req.headers['x-correlation-id']
    ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /health — liveness probe
// ─────────────────────────────────────────────────────────────────────────────

router.get('/health', (req, res) => {
  return res.status(200).json({
    ok:         true,
    service:    SERVICE_NAME,
    uptime:     Math.floor(process.uptime()),
    timestamp:  new Date().toISOString(),
    requestId:  getRequestId(req),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE CHECKS — Supabase + DB
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verify Supabase admin client connectivity by executing a lightweight
 * no-result query (limit 0). Returns { ok: true } or { ok: false, reason }.
 */
async function checkSupabase() {
  // Lazy-load to avoid circular dependency with supabaseClient module
  const supabase = require('../lib/supabaseClient');
  const { error } = await supabase
    .from('user_profiles')
    .select('id')
    .limit(0);

  if (error) throw new Error(error.message ?? 'supabase query failed');
}

/**
 * Verify direct Postgres connectivity via Supabase's rpc or a raw PG client.
 * Falls back to the same Supabase check if a separate pg client is not configured.
 */
async function checkDatabase() {
  // If you have a raw pg Pool, prefer: await pool.query('SELECT 1');
  // For Supabase-only setups, re-use the Supabase client with a different table:
  const supabase = require('../lib/supabaseClient');
  const { error } = await supabase.rpc('version'); // or any lightweight RPC

  // rpc('version') may not exist — fall back to a table query
  if (error && error.code !== 'PGRST301') { // PGRST301 = function not found
    const { error: e2 } = await supabase
      .from('user_profiles')
      .select('id')
      .limit(0);
    if (e2) throw new Error(e2.message ?? 'database query failed');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /ready — readiness probe
// ─────────────────────────────────────────────────────────────────────────────

router.get('/ready', async (req, res) => {
  const requestId = getRequestId(req);
  const start     = Date.now();

  // Run all checks in parallel — no check can block others
  const [supabaseResult, dbResult] = await Promise.allSettled([
    withReadinessTimeout(checkSupabase(), READINESS_TIMEOUT_MS),
    withReadinessTimeout(checkDatabase(), READINESS_TIMEOUT_MS),
  ]);

  const supabaseOk = supabaseResult.status === 'fulfilled' && supabaseResult.value.ok;
  const dbOk       = dbResult.status       === 'fulfilled' && dbResult.value.ok;

  const allOk = supabaseOk && dbOk;
  const durationMs = Date.now() - start;

  const body = {
    ok:       allOk,
    services: {
      supabase: supabaseOk ? 'up' : 'down',
      database: dbOk       ? 'up' : 'down',
    },
    timestamp:  new Date().toISOString(),
    requestId,
    durationMs,
    ...(
      !allOk ? {
        errors: {
          supabase: supabaseOk ? undefined : (
            supabaseResult.status === 'fulfilled'
              ? supabaseResult.value.reason
              : supabaseResult.reason?.message
          ),
          database: dbOk ? undefined : (
            dbResult.status === 'fulfilled'
              ? dbResult.value.reason
              : dbResult.reason?.message
          ),
        },
      } : {}
    ),
  };

  if (!allOk) {
    logger.warn('[Ready] Readiness check degraded', {
      requestId,
      services: body.services,
      durationMs,
    });
  }

  return res.status(allOk ? 200 : 503).json(body);
});

module.exports = router;