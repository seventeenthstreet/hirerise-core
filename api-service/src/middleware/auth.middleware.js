'use strict';

/**
 * api-service/src/middleware/auth.middleware.js — MIGRATED: Firebase → Supabase
 *
 * Replaces:
 *   import { getAuth } from 'firebase-admin/auth';
 *   getAuth().verifyIdToken(token, true)
 *
 * With:
 *   Supabase JWT verification using the service-role client.
 *
 * The Supabase JWT is a standard RS256-signed token. Verification uses
 * the Supabase Admin client's auth.getUser(token) method, which validates
 * the signature against Supabase's public keys automatically.
 *
 * No firebase-admin SDK is needed.
 *
 * Environment variables required:
 *   SUPABASE_URL              — your Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — service role key (never expose to clients)
 */

import { createClient } from '@supabase/supabase-js';
import { logger }       from '../../../shared/logger/index.js';

const PUBLIC_PATHS = new Set(['/health', '/health/ready', '/health/live']);

// Supabase Admin client — initialised once at startup
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

/**
 * authenticate — Express middleware
 *
 * Verifies the Bearer token in the Authorization header.
 * On success: sets req.user = { uid, email, emailVerified, roles }
 * On failure: returns 401
 */
export function authenticate(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({
      error:   'UNAUTHORIZED',
      message: 'Missing Bearer token',
    });
  }

  const token = authHeader.slice(7);

  // Verify the Supabase JWT asynchronously
  getSupabaseAdmin()
    .auth.getUser(token)
    .then(({ data, error }) => {
      if (error || !data.user) {
        logger.warn('Token verification failed', {
          ip:        req.ip,
          path:      req.path,
          errorMsg:  error?.message,
        });

        const isExpired = error?.message?.includes('expired');
        return res.status(401).json({
          error:   'UNAUTHORIZED',
          message: isExpired ? 'Token expired' : 'Invalid token',
        });
      }

      const user = data.user;

      req.user = {
        uid:            user.id,
        email:          user.email    ?? null,
        emailVerified:  user.email_confirmed_at != null,
        // Supabase stores custom claims in user_metadata or app_metadata
        roles: user.app_metadata?.roles ?? [],
        role:  user.app_metadata?.role  ?? 'user',
      };

      next();
    })
    .catch((err) => {
      logger.error('Auth middleware unexpected error', { err: err.message, path: req.path });
      res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Authentication error' });
    });
}

/**
 * requireEmailVerified — checks email_confirmed_at from Supabase
 */
export function requireEmailVerified(req, res, next) {
  if (!req.user?.emailVerified) {
    return res.status(403).json({
      error:   'FORBIDDEN',
      message: 'Email verification required',
    });
  }
  next();
}

/**
 * requireRole(role) — checks app_metadata.roles from Supabase
 *
 * To assign roles, use the Supabase Admin API:
 *   await supabaseAdmin.auth.admin.updateUserById(uid, {
 *     app_metadata: { role: 'admin', roles: ['admin'] }
 *   });
 */
export function requireRole(role) {
  return (req, res, next) => {
    if (!req.user?.roles?.includes(role)) {
      return res.status(403).json({
        error:   'FORBIDDEN',
        message: `Role '${role}' required`,
      });
    }
    next();
  };
}