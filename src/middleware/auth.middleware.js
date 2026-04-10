'use strict';

/**
 * authenticate.middleware.js
 *
 * Production-grade Supabase authentication middleware.
 *
 * Features:
 * - Singleton Supabase admin client
 * - Timeout-safe token verification
 * - Token cache fast path
 * - Metadata-first plan resolution
 * - Stable auth contract for all controllers
 * - Legacy uid bridge for zero-downtime migration
 * - Structured logging
 */

const { createClient } = require('@supabase/supabase-js');
const logger = require('../utils/logger');
const tokenCache = require('../core/tokenCache');
const { requireAdmin } = require('./requireAdmin.middleware');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const PUBLIC_PATHS = new Set([
  '/health',
  '/health/ready',
  '/health/live',
  '/api/v1/health',
]);

const SUPABASE_TIMEOUT_MS = 2000;

// ─────────────────────────────────────────────────────────────────────────────
// SUPABASE ADMIN SINGLETON
// ─────────────────────────────────────────────────────────────────────────────

let supabaseAdmin;

/**
 * Returns singleton Supabase admin client.
 * Reuses connection pool across all requests.
 *
 * @returns {import('@supabase/supabase-js').SupabaseClient}
 */
function getSupabaseAdmin() {
  if (supabaseAdmin) return supabaseAdmin;

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Safely decode JWT payload.
 * Used only for cache expiry extraction.
 *
 * @param {string} rawToken
 * @returns {Record<string, any>|null}
 */
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

/**
 * Build normalized downstream auth claims.
 *
 * Stable auth contract:
 * - id  = primary canonical user id
 * - sub = JWT compatible subject
 * - uid = temporary Firebase-era compatibility bridge
 *
 * @param {object} user
 * @param {string} plan
 * @returns {object}
 */
function buildClaimSet(user, plan) {
  const appMeta = user.app_metadata ?? {};
  const userMeta = user.user_metadata ?? {};

  const role = appMeta.role ?? userMeta.role ?? 'user';
  const roles = Array.isArray(appMeta.roles)
    ? appMeta.roles
    : [role];

  return {
    id: user.id,
    sub: user.id,
    uid: user.id, // TODO: remove after full migration
    email: user.email ?? null,
    emailVerified: Boolean(user.email_confirmed_at),

    role,
    roles,

    admin: Boolean(appMeta.admin || role === 'admin'),

    plan: plan ?? 'free',
    planAmount: appMeta.planAmount ?? null,
  };
}

/**
 * Resolve user subscription plan.
 * Fast path: metadata
 * Fallback: users table
 *
 * @param {object} user
 * @returns {Promise<string>}
 */
async function resolvePlan(user) {
  const appMeta = user.app_metadata ?? {};
  const metaPlan = appMeta.plan ?? appMeta.tier;

  // Fast path → avoid DB roundtrip
  if (metaPlan) return metaPlan;

  const { data, error } = await getSupabaseAdmin()
    .from('users')
    .select('tier')
    .eq('id', user.id)
    .maybeSingle();

  if (error) {
    logger.warn('[Auth] Plan lookup failed', {
      userId: user.id,
      error: error.message,
    });
    return 'free';
  }

  return data?.tier ?? 'free';
}

/**
 * Supabase auth call protected with timeout.
 *
 * @param {string} rawToken
 * @returns {Promise<any>}
 */
async function safeGetUser(rawToken) {
  return Promise.race([
    getSupabaseAdmin().auth.getUser(rawToken),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error('SUPABASE_TIMEOUT')),
        SUPABASE_TIMEOUT_MS
      )
    ),
  ]);
}

/**
 * Verify raw token and return normalized claims.
 *
 * @param {string} rawToken
 * @param {import('express').Request} req
 * @returns {Promise<object>}
 */
async function verifyToken(rawToken, req) {
  const { data, error } = await safeGetUser(rawToken);

  if (error || !data?.user) {
    throw new Error(error?.message || 'Invalid token');
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

/**
 * Cache verified claims using JWT exp.
 *
 * @param {string} rawToken
 * @param {object} claimSet
 */
function cacheVerifiedToken(rawToken, claimSet) {
  const payload = decodeJwtPayload(rawToken);
  const exp = payload?.exp ?? null;

  setImmediate(() => {
    tokenCache.set(rawToken, exp, claimSet);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN AUTH MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────

async function authenticate(req, res, next) {
  try {
    // Test bypass
    if (process.env.NODE_ENV === 'test') {
      req.user = {
        id: 'test-user',
        sub: 'test-user',
        uid: 'test-user',
        email: 'test@example.com',
        emailVerified: true,
        role: 'user',
        roles: ['user'],
        admin: false,
        plan: 'free',
        planAmount: null,
      };
      return next();
    }

    // Public routes bypass
    if (PUBLIC_PATHS.has(req.path)) {
      return next();
    }

    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        errorCode: 'UNAUTHORIZED',
        message: 'Missing Bearer token',
        timestamp: new Date().toISOString(),
      });
    }

    const rawToken = authHeader.slice(7);

    // Cache fast path
    const cached = await tokenCache.get(rawToken);
    if (cached) {
      req.user = cached;
      logger.debug('[Auth] Cache hit', {
        userId: cached.id,
      });
      return next();
    }

    // Verification path
    const claimSet = await verifyToken(rawToken, req);
    req.user = claimSet;

    // Non-blocking cache store
    cacheVerifiedToken(rawToken, claimSet);

    return next();
  } catch (error) {
    logger.warn('[Auth] Failed', {
      error: error.message,
      path: req.path,
      method: req.method,
      ip: req.ip,
    });

    const isExpired = error.message?.toLowerCase().includes('expired');

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

// ─────────────────────────────────────────────────────────────────────────────
// AUTHORIZATION GUARDS
// ─────────────────────────────────────────────────────────────────────────────

function requireEmailVerified(req, res, next) {
  if (!req.user?.emailVerified) {
    return res.status(403).json({
      success: false,
      errorCode: 'FORBIDDEN',
      message: 'Email verification required.',
      timestamp: new Date().toISOString(),
    });
  }

  return next();
}

function requireRole(requiredRole) {
  return (req, res, next) => {
    const userRole = req.user?.role;
    const roles = req.user?.roles ?? [];

    if (userRole !== requiredRole && !roles.includes(requiredRole)) {
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

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  authenticate,
  requireEmailVerified,
  requireAdmin,
  requireRole,
};