'use strict';

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
 * Mount-aware: Express strips the mount prefix before setting req.path, so
 * this function normalises both the full form ('/api/v1/health') and the
 * stripped form ('/health') to a bare suffix before matching.
 *
 * Examples that all return true:
 *   isPublicPath('/health')           ← per-route mount, stripped path
 *   isPublicPath('/api/v1/health')    ← edge-case where full path is passed
 *   isPublicPath('/health/deep')
 *   isPublicPath('/webhooks/stripe')
 *   isPublicPath('/internal/ai-job')
 */
function isPublicPath(reqPath = '') {
  // Normalise: strip /api/v1 prefix when present so both forms resolve
  // to a bare '/suffix' and the same Set/prefix checks apply regardless
  // of whether authenticate is mounted globally or per-route.
  const suffix = reqPath.startsWith(API_PREFIX)
    ? reqPath.slice(API_PREFIX.length) || '/'
    : reqPath;

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
  return Promise.race([
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
}

async function verifyToken(rawToken, req) {
  const { data, error } =
    await safeGetUser(rawToken);

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

    if (isPublicPath(req.path)) {
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

    req.user = claimSet;
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
});