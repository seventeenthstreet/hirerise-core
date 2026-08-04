/**
 * supabaseAuth.middleware.js
 *
 * PURPOSE:
 *   Verifies Supabase JWTs sent by the frontend via "Authorization: Bearer <JWT>".
 *
 * ROOT CAUSE CONTEXT:
 *   The existing auth.middleware.js uses Firebase Admin's verifyIdToken().
 *   The frontend (HireRise Next.js) authenticates via Supabase — it sends
 *   Supabase-issued JWTs, NOT Firebase ID tokens. Firebase Admin will reject
 *   every Supabase JWT with auth/argument-error or similar, causing every
 *   authenticated request to return 401.
 *
 *   Additionally, /api/v1/app-entry and /api/v1/users/me are not registered
 *   in src/server.js, so even with correct auth these calls return 404 which
 *   the frontend treats as a bootstrap failure, causing the session deadlock.
 *
 * THIS MIDDLEWARE:
 *   - Verifies Supabase JWTs using the Supabase service-role client and
 *     auth.getUser(accessToken) — the authoritative server-side verification path.
 *   - Populates req.supabaseUser with { id, email, user_metadata } on success.
 *   - Returns 401 on missing/invalid/expired tokens (no 500 leakage).
 *   - Never throws — all errors produce a structured JSON 401.
 *
 * USAGE:
 *   const { verifySupabaseToken } = require('./supabaseAuth.middleware');
 *   router.get('/app-entry', verifySupabaseToken, handler);
 *
 * ENV REQUIREMENTS (add to .env):
 *   SUPABASE_URL              — your Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — service-role key (server-only, never browser)
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');
// Node 20 (this repo's pinned engine) has no native global WebSocket.
// @supabase/supabase-js's RealtimeClient requires one at construction time
// even when realtime is unused, and throws synchronously without it.
const WebSocket = require('ws');

// ── Supabase admin client (service-role) ──────────────────────────────────────
// Lazy-initialised once — safe for long-lived server processes.
let _supabaseAdmin = null;

function getSupabaseAdmin() {
  if (_supabaseAdmin) return _supabaseAdmin;

  const url            = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      '[supabaseAuth] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment. ' +
      'Both are required for server-side JWT verification.',
    );
  }

  _supabaseAdmin = createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken:  false,
      persistSession:    false,
      detectSessionInUrl: false,
    },
    realtime: {
      transport: WebSocket,
    },
  });

  return _supabaseAdmin;
}

// ── Middleware ────────────────────────────────────────────────────────────────

/**
 * Express middleware that verifies a Supabase Bearer JWT.
 *
 * On success:  populates req.supabaseUser and calls next().
 * On failure:  responds 401 with { error: 'UNAUTHORIZED', message }.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function verifySupabaseToken(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({
      error:   'UNAUTHORIZED',
      message: 'Missing or malformed Authorization header. Expected: Bearer <token>',
    });
  }

  const token = authHeader.slice(7).trim();

  if (!token) {
    return res.status(401).json({
      error:   'UNAUTHORIZED',
      message: 'Empty Bearer token',
    });
  }

  try {
    const supabase = getSupabaseAdmin();

    // auth.getUser(jwt) is the canonical server-side token verification path.
    // It validates the JWT signature against your Supabase project's secret,
    // checks expiry, and returns the full user record — equivalent to Firebase's
    // verifyIdToken() but for Supabase-issued tokens.
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      // Log the Supabase error code for debugging without leaking it to the client.
      if (process.env.NODE_ENV !== 'production') {
        console.warn('[supabaseAuth] Token verification failed:', error?.message ?? 'no user returned');
      }

      return res.status(401).json({
        error:   'UNAUTHORIZED',
        message: error?.message?.includes('expired')
          ? 'Token expired — please refresh your session'
          : 'Invalid or unrecognised token',
      });
    }

    // Attach verified user to req for downstream handlers.
    // Shape mirrors what the old Firebase middleware set on req.user
    // so existing route handlers that read req.user.uid still work.
    req.supabaseUser = user;
    req.user = {
      uid:           user.id,           // Supabase UUID (same as auth.uid() in RLS)
      email:         user.email ?? null,
      emailVerified: user.email_confirmed_at != null,
      roles:         user.app_metadata?.roles ?? [],
    };

    next();
  } catch (err) {
    // Catch initialisation errors (missing env vars) and unexpected SDK errors.
    console.error('[supabaseAuth] Unexpected error during token verification:', err);
    return res.status(401).json({
      error:   'UNAUTHORIZED',
      message: 'Token verification failed',
    });
  }
}

module.exports = { verifySupabaseToken, getSupabaseAdmin };