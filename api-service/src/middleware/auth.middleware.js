'use strict';

import { createClient } from '@supabase/supabase-js';
import { logger } from '../../../shared/logger/index.js';

const PUBLIC_PATHS = new Set(['/health', '/health/ready', '/health/live']);

let _supabaseAdmin = null;

function getSupabaseAdmin() {
  if (_supabaseAdmin) return _supabaseAdmin;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.'
    );
  }

  _supabaseAdmin = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return _supabaseAdmin;
}

// Basic in-memory cache (optional lightweight optimization)
const tokenCache = new Map();
const TOKEN_CACHE_TTL = 60 * 1000; // 1 min

function getCachedUser(token) {
  const entry = tokenCache.get(token);
  if (!entry) return null;
  if (Date.now() > entry.expiry) {
    tokenCache.delete(token);
    return null;
  }
  return entry.user;
}

function setCachedUser(token, user) {
  tokenCache.set(token, {
    user,
    expiry: Date.now() + TOKEN_CACHE_TTL,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────

export function authenticate(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();

  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Missing Bearer token',
      requestId: req.requestId,
      timestamp: new Date().toISOString(),
    });
  }

  const token = authHeader.slice(7).trim();

  if (!token || token.split('.').length !== 3) {
    return res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Malformed token',
      requestId: req.requestId,
      timestamp: new Date().toISOString(),
    });
  }

  // Check cache first
  const cachedUser = getCachedUser(token);
  if (cachedUser) {
    req.user = cachedUser;
    return next();
  }

  getSupabaseAdmin()
    .auth.getUser(token)
    .then(({ data, error }) => {
      if (error || !data.user) {
        logger.warn('Token verification failed', {
          ip: req.ip,
          path: req.path,
          requestId: req.requestId,
          userAgent: req.headers['user-agent'],
          errorMsg: error?.message,
        });

        return res.status(401).json({
          error: 'UNAUTHORIZED',
          message: 'Invalid or expired token',
          requestId: req.requestId,
          timestamp: new Date().toISOString(),
        });
      }

      const user = data.user;

      const normalizedUser = {
        uid: user.id,
        email: user.email ?? null,
        emailVerified: user.email_confirmed_at != null,
        roles: user.app_metadata?.roles ?? [],
        role: user.app_metadata?.role ?? 'user',
      };

      // Cache it
      setCachedUser(token, normalizedUser);

      req.user = normalizedUser;

      next();
    })
    .catch((err) => {
      logger.error('Auth middleware unexpected error', {
        err: err.message,
        path: req.path,
        requestId: req.requestId,
      });

      return res.status(500).json({
        error: 'INTERNAL_ERROR',
        message: 'Authentication error',
        requestId: req.requestId,
        timestamp: new Date().toISOString(),
      });
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL VERIFICATION
// ─────────────────────────────────────────────────────────────────────────────

export function requireEmailVerified(req, res, next) {
  if (!req.user?.emailVerified) {
    return res.status(403).json({
      error: 'FORBIDDEN',
      message: 'Email verification required',
      requestId: req.requestId,
      timestamp: new Date().toISOString(),
    });
  }
  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// ROLE CHECK
// ─────────────────────────────────────────────────────────────────────────────

export function requireRole(role) {
  return (req, res, next) => {
    const userRoles = req.user?.roles || [];

    if (!userRoles.includes(role)) {
      return res.status(403).json({
        error: 'FORBIDDEN',
        message: `Role '${role}' required`,
        requestId: req.requestId,
        timestamp: new Date().toISOString(),
      });
    }

    next();
  };
}