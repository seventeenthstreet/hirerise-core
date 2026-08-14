'use strict';
console.log("✅ AUTH.MIDDLEWARE.JS LOADED FROM:", __filename);

/**
 * src/middleware/auth.middleware.js
 *
 * Wave 4 — Patch 42
 *
 * Final production auth authority
 * ✅ singleton Supabase admin client
 * ✅ timeout-safe JWT verification
 * ✅ token cache fast path
 * ✅ JWT-first billing tier resolution
 * ✅ tier micro-cache fallback
 * ✅ DB fallback only when JWT lacks plan
 * ✅ stable downstream req.user contract
 * ✅ mount-aware isPublicPath (works per-route AND global mounts)
 * ✅ opportunistic bounded expired-entry sweep on insertion
 *
 * Patch 42 — planMicroCache expired-entry sweep
 *   Introduces sweepExpiredPlanEntries(), called at every cache insertion
 *   point. Scans at most PLAN_CACHE_MAX_SWEEP_PER_INSERT (15) oldest entries
 *   and evicts any whose TTL has elapsed. This reclaims stale slots before
 *   the FIFO overflow guard can be triggered by live users, improving
 *   active-entry density without full-Map scans, background timers, or any
 *   change to authentication semantics or bounded-memory guarantees.
 *
 * Public path policy (no JWT required):
 *   /health          — load balancer liveness probe
 *   /health/*        — deep probe variants
 *   /ready           — Kubernetes readiness probe
 *   /webhooks        — Stripe/Razorpay (signature-verified inside handler)
 *   /webhooks/*      — same
 *   /internal/*      — Cloud Tasks (protected by requireInternalToken, not JWT)
 *   /metrics         — Prometheus (protected by requireInternalToken, not JWT)
 *
 * req.user contract (always set on every authenticated request):
 *   {
 *     id:            string   — Supabase user UUID (primary key)
 *     sub:           string   — alias for id (JWT 'sub' claim)
 *     uid:           string   — alias for id (legacy consumers)
 *     email:         string|null
 *     emailVerified: boolean
 *     role:          string   — 'user' | 'admin' | 'super_admin' | ...
 *     roles:         string[] — all roles (for multi-role checks)
 *     admin:         boolean  — true when role === 'admin' or app_metadata.admin
 *     plan:          string   — 'free' | 'pro' | 'enterprise' | ...
 *     planAmount:    number|null
 *   }
 */

const { createClient } = require('@supabase/supabase-js');
// Node 20 has no native global WebSocket — required by RealtimeClient at
// construction time even when realtime isn't used. See config/supabase.js.
const WebSocket = require('ws');
const logger = require('../utils/logger');
const tokenCache = require('../core/tokenCache');
const { requireAdmin } = require('./requireAdmin.middleware');

// ─────────────────────────────────────────────────────────────────────────────
// OBS Phases 1+2 — Structured auth event logger (inlined)
//
// Emits a structured JSON log for every JWT lifecycle event so that every
// auth decision is visible in production logs alongside requestId/hydrationId,
// enabling end-to-end trace correlation with frontend hydration events.
//
// Events: JWT_CACHE_HIT | JWT_VERIFIED | JWT_INVALID | JWT_EXPIRED | JWT_TIMEOUT
//
// Production safety: raw tokens never logged; never throws.
// ─────────────────────────────────────────────────────────────────────────────
function emitAuthEvent(req, event, context, level) {
  if (context === undefined) context = {};
  if (level    === undefined) level   = 'info';
  try {
    logger[level]('[Auth] ' + event, {
      event,
      requestId:   (req && req.requestId)   || (req && req.headers && req.headers['x-request-id'])   || null,
      hydrationId: (req && req.hydrationId) || (req && req.headers && req.headers['x-hydration-id']) || null,
      path:        (req && req.path)   || null,
      method:      (req && req.method) || null,
      timestamp:   new Date().toISOString(),
      ...context,
    });
  } catch (_) {
    // Auth logging must never break the auth path
  }
}

const API_PREFIX = '/api/v1';
const SUPABASE_TIMEOUT_MS = 2000;
const PLAN_CACHE_TTL_MS = 30000;
// Hard cap prevents unbounded heap growth on long-running servers.
// FIFO eviction: Map insertion order is stable, so .keys().next().value evicts the oldest.
const PLAN_CACHE_MAX_SIZE = 5000;
// Opportunistic sweep: max entries inspected per insertion for expired-entry reclamation.
// Small enough to preserve O(1)-ish insertion cost; large enough to reclaim stale slots
// meaningfully over time. Adjust between 10–25 based on profiling preference.
const PLAN_CACHE_MAX_SWEEP_PER_INSERT = 15;

let supabaseAdmin;
const planMicroCache = new Map();

function getSupabaseAdmin() {
  if (supabaseAdmin) return supabaseAdmin;

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error('Missing Supabase credentials');
  }

  supabaseAdmin = createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    realtime: {
      transport: WebSocket,
    },
  });

  return supabaseAdmin;
}

function decodeJwtPayload(rawToken) {
  try {
    const parts = rawToken.split('.');
    if (parts.length < 2) return null;

    return JSON.parse(
      Buffer.from(parts[1], 'base64').toString('utf8')
    );
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public path registry
// ─────────────────────────────────────────────────────────────────────────────
// Exact-match suffixes that never require a JWT.
// These are compared against the NORMALISED path (see isPublicPath below).
const PUBLIC_EXACT = new Set([
  '/health',
  '/ready',
  '/metrics',
  '/webhooks',
]);

// Prefix-match suffixes — any sub-path under these is also public.
const PUBLIC_PREFIXES = [
  '/health/',
  '/webhooks/',
  '/internal/',
];

/**
 * Returns true when the request path should bypass JWT verification.
 *
 * BUGFIX (WP-DIAG): must be called with the request's ORIGINAL, un-mounted
 * path (req.originalUrl), never req.path. `authenticate` is mounted
 * per-route throughout server.js (e.g.
 * `app.use('/api/v1/admin/graph', authenticate, ...)`), and Express strips
 * the matched mount prefix from `req.path`/`req.url` before invoking
 * per-route middleware. That meant a request to
 * GET /api/v1/admin/graph/health arrived at this function as bare
 * '/health' — an exact match against PUBLIC_EXACT — so `authenticate`
 * treated an authenticated admin sub-route as the public load-balancer
 * health check, skipped JWT verification entirely, and left req.user
 * unset. The next middleware (requireAdmin) then correctly rejected the
 * now-unauthenticated request with 401 UNAUTHORIZED. Same collision for
 * any route ending in /metrics, /health/*, /webhooks/*, /internal/* under
 * a non-public mount (graphAdmin's /health + /metrics were the two hit in
 * practice, but the flaw was in the matcher, not those two routes).
 *
 * Using req.originalUrl (unaffected by mount-stripping, always the full
 * path from the true request root) and matching only against the API
 * prefix's immediate suffix means a same-named sub-route nested under an
 * unrelated, non-public mount can never again be mistaken for the actual
 * top-level public endpoint.
 *
 * Examples that all return true:
 *   isPublicPath('/api/v1/health')       ← real public endpoint
 *   isPublicPath('/api/v1/health/deep')
 *   isPublicPath('/api/v1/webhooks/stripe')
 *   isPublicPath('/api/v1/internal/ai-job')
 *
 * Examples that now correctly return false (previously false positives):
 *   isPublicPath('/api/v1/admin/graph/health')
 *   isPublicPath('/api/v1/admin/graph/metrics')
 */
function isPublicPath(reqPath = '') {
  // Strip query string (originalUrl includes it; req.path never did) and
  // the /api/v1 prefix, so the remaining suffix reflects the FULL path
  // from the true app root, not a mount-relative fragment.
  const withoutQuery = reqPath.split('?')[0];
  const suffix = withoutQuery.startsWith(API_PREFIX)
    ? withoutQuery.slice(API_PREFIX.length) || '/'
    : withoutQuery;

  if (PUBLIC_EXACT.has(suffix)) return true;

  for (const prefix of PUBLIC_PREFIXES) {
    if (suffix.startsWith(prefix)) return true;
  }

  return false;
}


function buildClaimSet(user, plan) {
  const appMeta = user.app_metadata ?? {};
  const userMeta = user.user_metadata ?? {};

  const role =
    appMeta.role ?? userMeta.role ?? 'user';

  const roles = Array.isArray(appMeta.roles)
    ? appMeta.roles
    : [role];

  return Object.freeze({
    id: user.id,
    sub: user.id,
    uid: user.id,
    email: user.email ?? null,
    emailVerified: Boolean(
      user.email_confirmed_at
    ),
    role,
    roles,
    admin: Boolean(
      appMeta.admin || role === 'admin'
    ),
    plan: plan ?? 'free',
    planAmount: appMeta.planAmount ?? null,
  });
}

/**
 * sweepExpiredPlanEntries — opportunistic bounded expired-entry reclamation.
 *
 * Called once per cache insertion. Scans at most PLAN_CACHE_MAX_SWEEP_PER_INSERT
 * entries (oldest-first, because Map preserves insertion order) and deletes any
 * whose TTL has elapsed.
 *
 * Design properties:
 *   • O(k) work where k = PLAN_CACHE_MAX_SWEEP_PER_INSERT (constant, not Map size)
 *   • Improves active-entry density without a full scan
 *   • Preserves FIFO ordering — only expired entries are removed early
 *   • No timers, no background jobs, no external dependencies
 *   • Safe to call on every insertion; bounded CPU budget keeps it production-safe
 */
function sweepExpiredPlanEntries() {
  const now = Date.now();
  let scanned = 0;

  for (const [key, entry] of planMicroCache) {
    if (scanned >= PLAN_CACHE_MAX_SWEEP_PER_INSERT) break;
    if (entry.expiresAt <= now) {
      planMicroCache.delete(key);
    }
    scanned++;
  }
}

async function resolvePlan(user) {
  const appMeta = user.app_metadata ?? {};
  const jwtPlan = appMeta.plan ?? appMeta.tier;

  // Patch 40 → JWT-first fast path
  if (jwtPlan) {
    const cached = planMicroCache.get(user.id);

    if (
      !cached ||
      cached.value !== jwtPlan ||
      cached.expiresAt <= Date.now()
    ) {
      // Opportunistically reclaim expired slots before inserting.
      sweepExpiredPlanEntries();
      if (planMicroCache.size >= PLAN_CACHE_MAX_SIZE) {
        planMicroCache.delete(planMicroCache.keys().next().value);
      }
      planMicroCache.set(user.id, {
        value: jwtPlan,
        expiresAt: Date.now() + PLAN_CACHE_TTL_MS,
      });
    }

    return jwtPlan;
  }

  const cached = planMicroCache.get(user.id);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  try {
    const { data, error } = await getSupabaseAdmin()
      .from('subscriptions')
      .select('tier')
      .eq('user_id', user.id)
      .maybeSingle();

    if (error) {
      logger.warn('[Auth] Plan lookup failed', {
        userId: user.id,
        error: error.message,
      });
      return 'free';
    }

    const resolvedPlan = data?.tier ?? 'free';

    // Opportunistically reclaim expired slots before inserting.
    sweepExpiredPlanEntries();
    if (planMicroCache.size >= PLAN_CACHE_MAX_SIZE) {
      planMicroCache.delete(planMicroCache.keys().next().value);
    }
    planMicroCache.set(user.id, {
      value: resolvedPlan,
      expiresAt: Date.now() + PLAN_CACHE_TTL_MS,
    });

    return resolvedPlan;
  } catch (error) {
    logger.warn('[Auth] Plan lookup exception', {
      userId: user.id,
      error: error.message,
    });

    return 'free';
  }
}

async function safeGetUser(rawToken) {
  // WP-DIAG-01 TEMP — diagnostic-only, remove alongside the other
  // [WP-DIAG] log calls in this file once the investigation is closed.
  const wpDiagStartedAt = Date.now();
  logger.info('[WP-DIAG] safeGetUser start', {
    rawTokenStart: rawToken?.slice(0, 12) ?? null,
    timestamp: new Date(wpDiagStartedAt).toISOString(),
  });

  try {
    const result = await Promise.race([
      getSupabaseAdmin().auth.getUser(rawToken),
      new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error('SUPABASE_TIMEOUT')
            ),
          SUPABASE_TIMEOUT_MS
        )
      ),
    ]);

    // WP-DIAG-01 TEMP
    logger.info('[WP-DIAG] safeGetUser end', {
      rawTokenStart: rawToken?.slice(0, 12) ?? null,
      elapsedMs:     Date.now() - wpDiagStartedAt,
      outcome:       result?.error ? 'supabase-error' : 'success',
      timeout:       false,
    });

    return result;
  } catch (err) {
    // WP-DIAG-01 TEMP
    logger.info('[WP-DIAG] safeGetUser end', {
      rawTokenStart: rawToken?.slice(0, 12) ?? null,
      elapsedMs:     Date.now() - wpDiagStartedAt,
      outcome:       err?.message === 'SUPABASE_TIMEOUT' ? 'timeout' : 'error',
      timeout:       err?.message === 'SUPABASE_TIMEOUT',
      reason:        err?.message ?? null,
    });
    throw err;
  }
}

async function verifyToken(rawToken, req) {
  console.log("\n🔥🔥🔥 VERIFY TOKEN EXECUTED 🔥🔥🔥");

  // WP-DIAG-01 TEMP — diagnostic-only, remove alongside the other
  // [WP-DIAG] log calls in this file once the investigation is closed.
  const wpDiagVerifyStartedAt = Date.now();
  logger.info('[WP-DIAG] verifyToken start', {
    requestId: req?.requestId ?? null,
    path:      req?.path ?? null,
    method:    req?.method ?? null,
    timestamp: new Date(wpDiagVerifyStartedAt).toISOString(),
  });

  const wpDiagSupabaseStartedAt = Date.now();
  let wpDiagSupabaseOutcome = 'success';
  let data, error;
  try {
    ({ data, error } = await safeGetUser(rawToken));
  } catch (err) {
    wpDiagSupabaseOutcome = err?.message === 'SUPABASE_TIMEOUT' ? 'timeout' : 'error';
    // WP-DIAG-01 TEMP
    logger.info('[WP-DIAG] verifyToken end', {
      requestId:         req?.requestId ?? null,
      path:              req?.path ?? null,
      elapsedMs:         Date.now() - wpDiagVerifyStartedAt,
      supabaseDurationMs: Date.now() - wpDiagSupabaseStartedAt,
      success:           false,
      timeout:           wpDiagSupabaseOutcome === 'timeout',
      reason:            err?.message ?? null,
    });
    throw err;
  }
  // WP-DIAG-01 TEMP
  logger.info('[WP-DIAG] verifyToken supabase call finished', {
    requestId:          req?.requestId ?? null,
    supabaseDurationMs: Date.now() - wpDiagSupabaseStartedAt,
    outcome:            wpDiagSupabaseOutcome,
  });

  if (error || !data?.user) {
    logger.error('[Auth Verify Failed]', {
      error,
      errorMessage: error?.message,
      errorStatus: error?.status,
      errorCode: error?.code,
      rawTokenStart: rawToken?.slice(0, 30),
      hasUser: !!data?.user,
      path: req.path,
      method: req.method,
    });

    console.error('\n========== AUTH VERIFY DEBUG ==========');
    console.error('Supabase Error Message:', error?.message);
    console.error('Supabase Error Status :', error?.status);
    console.error('Supabase Error Code   :', error?.code);
    console.error('Supabase Error Object :', error);
    console.error('Has User              :', !!data?.user);
    console.error('=======================================\n');

    // WP-DIAG-01 TEMP
    logger.info('[WP-DIAG] verifyToken end', {
      requestId: req?.requestId ?? null,
      path:      req?.path ?? null,
      elapsedMs: Date.now() - wpDiagVerifyStartedAt,
      success:   false,
      timeout:   false,
      reason:    error?.message || 'Invalid token',
    });

    throw new Error(
      error?.message || 'Invalid token'
    );
  }

  const user = data.user;
  const plan = await resolvePlan(user);
  const claimSet = buildClaimSet(user, plan);

  logger.info('[Auth] Verified', {
    userId: claimSet.id,
    path: req.path,
    method: req.method,
  });

  // WP-DIAG-01 TEMP
  logger.info('[WP-DIAG] verifyToken end', {
    requestId: req?.requestId ?? null,
    userId:    claimSet.id,
    path:      req?.path ?? null,
    elapsedMs: Date.now() - wpDiagVerifyStartedAt,
    success:   true,
    timeout:   false,
  });

  return claimSet;
}


function cacheVerifiedToken(rawToken, claimSet) {
  const payload = decodeJwtPayload(rawToken);
  const exp = payload?.exp ?? null;

  setImmediate(() => {
    tokenCache.set(rawToken, exp, claimSet);
  });
}

async function authenticate(req, res, next) {
  try {
    // OBS Phase 2: read correlation IDs injected by the frontend's
    // buildCorrelationHeaders() and attach to req for downstream handlers.
    // correlationMiddleware is the canonical source; this is a safe fallback
    // for routes that don't run through the global middleware stack.
    if (!req.requestId) {
      req.requestId   = req.headers['x-request-id']   ?? null;
      req.hydrationId = req.headers['x-hydration-id'] ?? null;
    }

    if (isPublicPath(req.originalUrl)) {
      return next();
    }

    const authHeader =
      req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      // V2 canonical error shape — migrated from { errorCode, message } transitional shape
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Missing Bearer token',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    const rawToken = authHeader.slice(7);

    const cached = await tokenCache.get(rawToken);
    if (cached) {
      req.user = cached;
      logger.debug('[Auth] Cache hit', {
        userId: cached.id,
      });
      // OBS Phase 1+2: structured JWT cache-hit event
      emitAuthEvent(req, 'JWT_CACHE_HIT', { userId: cached.id, plan: cached.plan });
      return next();
    }

    const claimSet = await verifyToken(
      rawToken,
      req
    );

    // Patch — WP-DASH-04: buildClaimSet() returns an Object.freeze()'d
    // claim set (by design, to protect the canonical authenticated
    // identity from accidental mutation). Downstream middleware/routes
    // (dashboard.route.js, requireTier.middleware.js,
    // requirePaidPlan.middleware.js) legitimately attach request-scoped
    // derived properties such as normalizedTier directly onto req.user.
    // Assigning the frozen claimSet itself caused a TypeError on that
    // write. req.user is therefore a shallow, request-scoped mutable
    // clone of the frozen claim set: the canonical claimSet (and the
    // copy persisted via cacheVerifiedToken below) stays frozen and
    // untouched, while each request gets its own plain object to
    // annotate. This changes no claim values, no auth/authz behavior,
    // and no JWT/token-cache logic — only the mutability of the object
    // reference assigned to req.user.
    req.user = { ...claimSet };
    // OBS Phase 1+2: structured JWT verified event (verifyToken already logs
    // '[Auth] Verified' at info level; this adds requestId/hydrationId context)
    emitAuthEvent(req, 'JWT_VERIFIED', { userId: claimSet.id, plan: claimSet.plan, role: claimSet.role });
    cacheVerifiedToken(rawToken, claimSet);

    return next();
  } catch (error) {
    logger.warn('[Auth] Failed', {
      error: error.message,
      path: req.path,
      method: req.method,
      ip: req.ip,
    });

    const isExpired  = error.message?.toLowerCase().includes('expired');
    const isTimeout  = error.message === 'SUPABASE_TIMEOUT';

    // OBS Phase 1+2: structured auth failure event
    emitAuthEvent(req,
      isTimeout ? 'JWT_TIMEOUT' : isExpired ? 'JWT_EXPIRED' : 'JWT_INVALID',
      { reason: error.message, status: 401, isExpired, isTimeout },
      'warn',
    );

    // V2 canonical error shape — migrated from { errorCode, message } transitional shape
    return res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: isExpired
          ? 'Token expired. Please refresh.'
          : 'Invalid token.',
      },
      meta: {
        timestamp: new Date().toISOString(),
      },
    });
  }
}

function requireEmailVerified(
  req,
  res,
  next
) {
  if (!req.user?.emailVerified) {
    // V2 canonical error shape — migrated from { errorCode, message } transitional shape
    return res.status(403).json({
      success: false,
      error: {
        code: 'FORBIDDEN',
        message: 'Email verification required.',
      },
      meta: {
        timestamp: new Date().toISOString(),
      },
    });
  }

  return next();
}

function requireRole(requiredRole) {
  return (req, res, next) => {
    const userRole = req.user?.role;
    const roles = req.user?.roles ?? [];

    if (
      userRole !== requiredRole &&
      !roles.includes(requiredRole)
    ) {
      return res.status(403).json({
        success: false,
        // V2 canonical error shape — migrated from { errorCode, message } transitional shape
        error: {
          code: 'FORBIDDEN',
          message: `Role '${requiredRole}' required.`,
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    return next();
  };
}

module.exports = Object.freeze({
  authenticate,
  requireEmailVerified,
  requireAdmin,
  requireRole,
  // Exported for regression testing (WP-DIAG mount-collision bugfix) only —
  // not intended as a general-purpose API for other modules.
  isPublicPath,
});