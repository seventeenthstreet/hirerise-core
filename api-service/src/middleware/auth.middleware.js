'use strict';

import { createClient } from '@supabase/supabase-js';
import { logger } from '../../../shared/logger/index.js';

const PUBLIC_PATHS = new Set(['/health', '/health/ready', '/health/live']);
const TOKEN_CACHE_TTL_MS = 60 * 1000; // 1 minute
const TOKEN_CACHE_MAX_SIZE = 1000;

let supabaseAdminSingleton = globalThis.__SUPABASE_ADMIN__ ?? null;
const tokenCache = globalThis.__AUTH_TOKEN_CACHE__ ?? new Map();

globalThis.__AUTH_TOKEN_CACHE__ = tokenCache;

function getTimestamp() {
  return new Date().toISOString();
}

function sendError(res, status, error, message, requestId) {
  return res.status(status).json({
    error,
    message,
    requestId,
    timestamp: getTimestamp(),
  });
}

function getSupabaseAdmin() {
  if (supabaseAdminSingleton) return supabaseAdminSingleton;

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  }

  supabaseAdminSingleton = createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: {
        'x-client-info': 'api-service/auth-middleware',
      },
    },
  });

  globalThis.__SUPABASE_ADMIN__ = supabaseAdminSingleton;
  return supabaseAdminSingleton;
}

function pruneTokenCacheIfNeeded() {
  if (tokenCache.size < TOKEN_CACHE_MAX_SIZE) return;

  const now = Date.now();
  for (const [key, value] of tokenCache.entries()) {
    if (value.expiry <= now) {
      tokenCache.delete(key);
    }
  }

  if (tokenCache.size < TOKEN_CACHE_MAX_SIZE) return;

  const oldestKey = tokenCache.keys().next().value;
  if (oldestKey) tokenCache.delete(oldestKey);
}

function getCachedUser(token) {
  const cached = tokenCache.get(token);
  if (!cached) return null;

  if (cached.expiry <= Date.now()) {
    tokenCache.delete(token);
    return null;
  }

  return cached.user;
}

function setCachedUser(token, user) {
  pruneTokenCacheIfNeeded();

  tokenCache.set(token, {
    user,
    expiry: Date.now() + TOKEN_CACHE_TTL_MS,
  });
}

function normalizeUser(user) {
  const roles = Array.isArray(user?.app_metadata?.roles)
    ? user.app_metadata.roles
    : [];

  return {
    uid: user.id,
    email: user.email ?? null,
    emailVerified: Boolean(user.email_confirmed_at),
    roles,
    role: user.app_metadata?.role ?? roles[0] ?? 'user',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────

export async function authenticate(req, res, next) {
  try {
    if (PUBLIC_PATHS.has(req.path)) {
      return next();
    }

    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return sendError(
        res,
        401,
        'UNAUTHORIZED',
        'Missing Bearer token',
        req.requestId
      );
    }

    const token = authHeader.slice(7).trim();

    if (!token || token.split('.').length !== 3) {
      return sendError(
        res,
        401,
        'UNAUTHORIZED',
        'Malformed token',
        req.requestId
      );
    }

    const cachedUser = getCachedUser(token);
    if (cachedUser) {
      req.user = cachedUser;
      return next();
    }

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data?.user) {
      logger.warn('Token verification failed', {
        ip: req.ip,
        path: req.path,
        requestId: req.requestId,
        userAgent: req.headers['user-agent'],
        error: error?.message ?? 'User not found',
      });

      return sendError(
        res,
        401,
        'UNAUTHORIZED',
        'Invalid or expired token',
        req.requestId
      );
    }

    const normalizedUser = normalizeUser(data.user);
    setCachedUser(token, normalizedUser);

    req.user = normalizedUser;
    return next();
  } catch (error) {
    logger.error('Auth middleware unexpected error', {
      error: error.message,
      path: req.path,
      requestId: req.requestId,
    });

    return sendError(
      res,
      500,
      'INTERNAL_ERROR',
      'Authentication error',
      req.requestId
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL VERIFICATION
// ─────────────────────────────────────────────────────────────────────────────

export function requireEmailVerified(req, res, next) {
  if (!req.user?.emailVerified) {
    return sendError(
      res,
      403,
      'FORBIDDEN',
      'Email verification required',
      req.requestId
    );
  }

  return next();
}

// ─────────────────────────────────────────────────────────────────────────────
// ROLE CHECK
// ─────────────────────────────────────────────────────────────────────────────

export function requireRole(role) {
  return function roleGuard(req, res, next) {
    const userRoles = Array.isArray(req.user?.roles) ? req.user.roles : [];

    if (!userRoles.includes(role)) {
      return sendError(
        res,
        403,
        'FORBIDDEN',
        `Role '${role}' required`,
        req.requestId
      );
    }

    return next();
  };
}
