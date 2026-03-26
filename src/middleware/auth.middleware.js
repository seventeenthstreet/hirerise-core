'use strict';

/**
 * src/middleware/auth.middleware.js — MIGRATED: Firebase → Supabase
 *
 * FIX: The tokenCache.set() call was passing `user` (Supabase User object)
 * as the second argument, but tokenCache.computeTtl() expects an object with
 * an `.exp` field (Unix timestamp). Supabase User objects don't have `.exp`
 * at the top level — that lives in the JWT payload.
 *
 * WHAT CHANGED from previous version:
 *   - Added decodeJwtPayload() helper to safely extract exp from the JWT
 *   - tokenCache.set(rawToken, user, claimSet)
 *       → tokenCache.set(rawToken, jwtPayload?.exp, claimSet)
 *   - This ensures TTL is correctly bounded by the token's actual expiry
 *
 * EVERYTHING ELSE IS UNCHANGED:
 *   - Supabase Admin client singleton
 *   - getUser() for JWT verification
 *   - buildClaimSet() shape
 *   - resolvePlan() with Supabase DB lookup
 *   - PUBLIC_PATHS bypass
 *   - TEST mode mock
 *   - 401 response format
 *
 * Environment variables required:
 *   SUPABASE_URL              — your Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — service role key (never expose to clients)
 */

const { createClient } = require('@supabase/supabase-js');
const logger           = require('../utils/logger');
const tokenCache       = require('../core/tokenCache');

const PUBLIC_PATHS = new Set([
  '/health',
  '/health/ready',
  '/health/live',
  '/api/v1/health',
]);

// ─── Supabase Admin Client (singleton) ───────────────────────────────────────

let _supabaseAdmin = null;

function getSupabaseAdmin() {
  if (_supabaseAdmin) return _supabaseAdmin;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.\n' +
      'These are required for JWT verification in auth.middleware.js'
    );
  }

  _supabaseAdmin = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return _supabaseAdmin;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * decodeJwtPayload(rawToken)
 *
 * Extracts the payload from a JWT without verifying the signature.
 * Used ONLY to read the `exp` claim for cache TTL calculation.
 * The actual signature verification is done by Supabase's getUser().
 *
 * @param {string} rawToken — raw Bearer token
 * @returns {{ exp?: number } | null}
 */
function decodeJwtPayload(rawToken) {
  try {
    const parts = rawToken.split('.');
    if (parts.length !== 3) return null;
    // Use 'base64url' if available (Node 16+), fall back to manual padding
    const payloadJson = Buffer.from(
      parts[1].replace(/-/g, '+').replace(/_/g, '/'),
      'base64'
    ).toString('utf8');
    return JSON.parse(payloadJson);
  } catch {
    return null;
  }
}

function buildClaimSet(user, resolvedPlan) {
  const meta  = user.app_metadata  ?? {};
  const umeta = user.user_metadata ?? {};

  return {
    uid:           user.id,
    email:         user.email               ?? null,
    emailVerified: user.email_confirmed_at != null,
    roles:         meta.roles               ?? [],
    plan:          resolvedPlan             ?? 'free',
    role:          meta.role                ?? umeta.role ?? null,
    admin:         meta.admin               ?? (meta.role === 'admin') ?? false,
    planAmount:    meta.planAmount          ?? null,
  };
}

async function resolvePlan(user) {
  const metaPlan = user.app_metadata?.plan ?? user.app_metadata?.tier ?? null;
  if (metaPlan && metaPlan !== 'free') return metaPlan;

  try {
    const { data, error } = await getSupabaseAdmin()
      .from('users')
      .select('plan, tier')
      .eq('id', user.id)
      .single();

    if (!error && data) {
      const supabasePlan = data.tier ?? data.plan ?? null;
      if (supabasePlan && supabasePlan !== 'free') return supabasePlan;
    }
  } catch {
    // Non-fatal — default to free
  }

  return 'free';
}

// ─── AUTHENTICATE ─────────────────────────────────────────────────────────────

const authenticate = (req, res, next) => {

  // Test mode bypass
  if (process.env.NODE_ENV === 'test') {
    const isAdmin = process.env.TEST_ADMIN === 'true';
    req.user = {
      uid:           'test-user',
      email:         'test@example.com',
      emailVerified: true,
      roles:         isAdmin ? ['admin', 'user'] : ['user'],
      plan:          process.env.TEST_PLAN ?? 'free',
      role:          process.env.TEST_ROLE ?? (isAdmin ? 'admin' : null),
      admin:         isAdmin,
    };
    return next();
  }

  if (PUBLIC_PATHS.has(req.path)) return next();

  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success:   false,
      errorCode: 'UNAUTHORIZED',
      message:   'Missing Bearer token',
      timestamp: new Date().toISOString(),
    });
  }

  const rawToken = authHeader.slice(7);

  // ── Cache lookup ────────────────────────────────────────────────────────────

  tokenCache.get(rawToken).then(async (cached) => {

    if (cached) {
      req.user = cached;
      logger.debug('[Auth] Token served from cache', { uid: cached.uid });
      return next();
    }

    // ── Supabase JWT verification ────────────────────────────────────────────

    try {
      const { data, error } = await getSupabaseAdmin().auth.getUser(rawToken);

      if (error || !data.user) {
        logger.warn('[Auth] Token verification failed', {
          ip:            req.ip,
          path:          req.path,
          correlationId: req.headers['x-correlation-id'],
          errorCode:     error?.status ?? 'unknown',
          errorMsg:      error?.message,
        });

        const isExpired = error?.message?.toLowerCase().includes('expired');
        return res.status(401).json({
          success:   false,
          errorCode: 'UNAUTHORIZED',
          message:   isExpired
            ? 'Token expired. Please refresh and retry.'
            : 'Invalid token.',
          timestamp: new Date().toISOString(),
        });
      }

      const user         = data.user;
      const resolvedPlan = await resolvePlan(user);
      const claimSet     = buildClaimSet(user, resolvedPlan);

      req.user = claimSet;

      logger.info('[Auth] Token verified successfully', {
        uid:   claimSet.uid,
        email: claimSet.email,
        plan:  claimSet.plan,
        admin: claimSet.admin,
        path:  req.path,
        ip:    req.ip,
      });

      // FIX: Extract exp from JWT payload for correct cache TTL calculation.
      // Previously `user` (Supabase User object) was passed, which has no .exp.
      // Now we decode the JWT payload and pass the exp claim directly.
      const jwtPayload = decodeJwtPayload(rawToken);
      setImmediate(() => tokenCache.set(rawToken, jwtPayload?.exp, claimSet));

      next();

    } catch (err) {
      logger.error('[Auth] Token verification threw unexpectedly', {
        ip:        req.ip,
        path:      req.path,
        errorCode: err.code ?? err.status ?? 'unknown',
        error:     err.message,
        stack:     err.stack,
      });

      return res.status(401).json({
        success:   false,
        errorCode: 'UNAUTHORIZED',
        message:   'Invalid token.',
        timestamp: new Date().toISOString(),
      });
    }

  }).catch(async (cacheErr) => {

    // Redis error — fall back to direct Supabase verification
    logger.warn('[Auth] Token cache error, falling back to Supabase', {
      err: cacheErr.message,
    });

    try {
      const { data, error } = await getSupabaseAdmin().auth.getUser(rawToken);

      if (error || !data.user) {
        logger.warn('[Auth] Token verification failed (cache-fallback path)', {
          ip:        req.ip,
          path:      req.path,
          errorCode: error?.status ?? 'unknown',
          errorMsg:  error?.message,
        });
        return res.status(401).json({
          success:   false,
          errorCode: 'UNAUTHORIZED',
          message:   'Invalid token.',
          timestamp: new Date().toISOString(),
        });
      }

      const user         = data.user;
      const resolvedPlan = await resolvePlan(user);
      req.user           = buildClaimSet(user, resolvedPlan);

      logger.info('[Auth] Token verified successfully (cache-fallback path)', {
        uid:  req.user.uid,
        path: req.path,
        ip:   req.ip,
      });

      next();

    } catch (err) {
      logger.error('[Auth] Token verification threw in cache-fallback path', {
        ip:        req.ip,
        path:      req.path,
        errorCode: err.code ?? err.status ?? 'unknown',
        error:     err.message,
        stack:     err.stack,
      });
      res.status(401).json({
        success:   false,
        errorCode: 'UNAUTHORIZED',
        message:   'Invalid token.',
        timestamp: new Date().toISOString(),
      });
    }

  });

};

// ─── REQUIRE EMAIL VERIFIED ───────────────────────────────────────────────────

const requireEmailVerified = (req, res, next) => {
  if (!req.user?.emailVerified) {
    return res.status(403).json({
      success:   false,
      errorCode: 'FORBIDDEN',
      message:   'Email verification required.',
      timestamp: new Date().toISOString(),
    });
  }
  next();
};

// ─── ADMIN CHECK (RE-EXPORT) ──────────────────────────────────────────────────

const { requireAdmin } = require('./requireAdmin.middleware');

// ─── ROLE CHECK ───────────────────────────────────────────────────────────────

const requireRole = (role) => {
  return (req, res, next) => {
    const userRole  = req.user?.role;
    const userRoles = req.user?.roles ?? [];

    if (userRole !== role && !userRoles.includes(role)) {
      return res.status(403).json({
        success:   false,
        errorCode: 'FORBIDDEN',
        message:   `Role '${role}' required.`,
        timestamp: new Date().toISOString(),
      });
    }
    next();
  };
};

module.exports = {
  authenticate,
  requireEmailVerified,
  requireAdmin,
  requireRole,
};