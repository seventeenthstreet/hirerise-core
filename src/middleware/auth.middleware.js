'use strict';

/**
 * src/middleware/auth.middleware.js
 *
 * Wave 4 — Patch 41
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
 *
 * Patch 41 — isPublicPath rewrite
 *   Previously compared req.path against full '/api/v1/health' strings.
 *   When authenticate is mounted globally at app.use('/api/v1', authenticate),
 *   Express strips the prefix so req.path arrives as '/health' — the old check
 *   never matched and health/ready probes were incorrectly challenged for a JWT.
 *   The new implementation normalises both forms to a bare suffix before matching.
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

const API_PREFIX = '/api/v1';
const SUPABASE_TIMEOUT_MS = 2000;
const PLAN_CACHE_TTL_MS = 30000;

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
    if (isPublicPath(req.path)) {
      return next();
    }

    const authHeader =
      req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        errorCode: 'UNAUTHORIZED',
        message: 'Missing Bearer token',
        timestamp: new Date().toISOString(),
      });
    }

    const rawToken = authHeader.slice(7);

    const cached = await tokenCache.get(rawToken);
    if (cached) {
      req.user = cached;
      logger.debug('[Auth] Cache hit', {
        userId: cached.id,
      });
      return next();
    }

    const claimSet = await verifyToken(
      rawToken,
      req
    );

    req.user = claimSet;
    cacheVerifiedToken(rawToken, claimSet);

    return next();
  } catch (error) {
    logger.warn('[Auth] Failed', {
      error: error.message,
      path: req.path,
      method: req.method,
      ip: req.ip,
    });

    const isExpired = error.message
      ?.toLowerCase()
      .includes('expired');

    return res.status(401).json({
      success: false,
      errorCode: 'UNAUTHORIZED',
      message: isExpired
        ? 'Token expired. Please refresh.'
        : 'Invalid token.',
      timestamp: new Date().toISOString(),
    });
  }
}

function requireEmailVerified(
  req,
  res,
  next
) {
  if (!req.user?.emailVerified) {
    return res.status(403).json({
      success: false,
      errorCode: 'FORBIDDEN',
      message:
        'Email verification required.',
      timestamp: new Date().toISOString(),
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
        errorCode: 'FORBIDDEN',
        message: `Role '${requiredRole}' required.`,
        timestamp: new Date().toISOString(),
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