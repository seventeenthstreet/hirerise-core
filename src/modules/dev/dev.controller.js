'use strict';

/**
 * dev.controller.js
 *
 * MIGRATION: firebase-admin removed entirely.
 *
 * Original behaviour:
 *   1. setCustomUserClaims(DEV_ADMIN_UID, claims)  — persisted claims to Firebase Auth
 *   2. createCustomToken(DEV_ADMIN_UID, claims)    — returned a custom token the
 *      frontend exchanged for an ID token via signInWithCustomToken()
 *
 * Supabase equivalent:
 *   1. Ensure the dev-admin user exists in Supabase Auth (create if absent).
 *   2. Write MASTER_ADMIN claims into app_metadata via auth.admin.updateUserById().
 *      auth.middleware.js reads user.app_metadata.role — this is the correct field.
 *   3. Return an access_token by generating a sign-in link and exchanging it,
 *      OR (simpler for local dev) use admin.generateLink to get a magic-link token,
 *      OR just return the user id + instruct the dev to sign in via the frontend.
 *
 * CHOSEN APPROACH — generateLink('magiclink'):
 *   Supabase does not have createCustomToken. The closest equivalent that gives
 *   a usable JWT without a password is admin.generateLink('magiclink', email).
 *   This returns a hashed token URL; the frontend exchanges it via
 *   supabase.auth.verifyOtp({ token_hash, type: 'magiclink' }) to get a session.
 *
 * ENVIRONMENT VARIABLES REQUIRED:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   DEV_ADMIN_EMAIL  — e.g. dev-admin@hirerise.internal  (add to .env)
 *   DEV_ADMIN_PASSWORD — fallback password for signInWithPassword (add to .env)
 *
 * This route is only mounted when NODE_ENV !== 'production' (see server.js).
 */

const { createClient } = require('@supabase/supabase-js');
const logger           = require('../../utils/logger');

const DEV_ADMIN_EMAIL    = process.env.DEV_ADMIN_EMAIL    || 'dev-admin@hirerise.internal';
const DEV_ADMIN_PASSWORD = process.env.DEV_ADMIN_PASSWORD || 'DevAdmin123!';

const DEV_ADMIN_APP_METADATA = {
  role:  'MASTER_ADMIN',
  admin: true,
  plan:  'pro',
  tier:  'pro',
};

// ─── Supabase service-role client (singleton) ─────────────────────────────────

let _supabase = null;

function getSupabase() {
  if (_supabase) return _supabase;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      '[dev.controller] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.'
    );
  }

  _supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return _supabase;
}

// ─── Ensure dev-admin user exists and has correct claims ──────────────────────

async function ensureDevAdminUser(supabase) {
  // Try to look up the user by email first
  const { data: listData, error: listErr } = await supabase.auth.admin.listUsers();

  if (listErr) {
    logger.warn('[DevController] Could not list users to find dev-admin', {
      error: listErr.message,
    });
    // Fall through — we'll try createUser and handle the duplicate error
  }

  const existing = listData?.users?.find(u => u.email === DEV_ADMIN_EMAIL);

  if (existing) {
    // User exists — ensure claims are up to date
    const { error: updateErr } = await supabase.auth.admin.updateUserById(existing.id, {
      app_metadata: DEV_ADMIN_APP_METADATA,
      password:     DEV_ADMIN_PASSWORD,   // keep password in sync with env var
    });

    if (updateErr) {
      logger.warn('[DevController] Failed to update dev-admin claims', {
        error: updateErr.message,
      });
    }

    return existing.id;
  }

  // User does not exist — create them
  const { data: created, error: createErr } = await supabase.auth.admin.createUser({
    email:            DEV_ADMIN_EMAIL,
    password:         DEV_ADMIN_PASSWORD,
    email_confirm:    true,               // skip email verification for dev user
    app_metadata:     DEV_ADMIN_APP_METADATA,
  });

  if (createErr) {
    throw new Error(`[DevController] Failed to create dev-admin user: ${createErr.message}`);
  }

  logger.info('[DevController] Dev-admin Supabase user created', {
    uid: created.user.id,
  });

  return created.user.id;
}

// ─── POST /dev/login ──────────────────────────────────────────────────────────
//
// Returns an access_token the frontend can use directly as a Bearer token,
// plus a refresh_token for session persistence.
//
// Frontend usage (replaces signInWithCustomToken):
//   const res = await fetch('/api/v1/dev/login', { method: 'POST' });
//   const { data: { access_token, refresh_token } } = await res.json();
//   // Restore the session manually:
//   await supabase.auth.setSession({ access_token, refresh_token });
//   // OR store the token and pass it as Authorization: Bearer <access_token>

exports.generateDevToken = async (req, res, next) => {
  try {
    const supabase = getSupabase();

    // 1. Ensure user exists with correct claims
    await ensureDevAdminUser(supabase);

    // 2. Sign in with password to get a real access_token.
    //    We use a separate anon client here because the service-role client's
    //    auth.signInWithPassword behaves differently — use the anon key client.
    const anonClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',
      { auth: { persistSession: false } },
    );

    const { data: session, error: signInErr } = await anonClient.auth.signInWithPassword({
      email:    DEV_ADMIN_EMAIL,
      password: DEV_ADMIN_PASSWORD,
    });

    if (signInErr || !session?.session) {
      logger.error('[DevController] Dev sign-in failed', {
        error: signInErr?.message ?? 'no session returned',
      });
      return res.status(500).json({
        success: false,
        error:   signInErr?.message ?? 'Sign-in failed. Check DEV_ADMIN_PASSWORD.',
      });
    }

    logger.info('[DevController] Dev-admin token issued', {
      uid: session.user.id,
    });

    return res.json({
      success: true,
      data: {
        access_token:  session.session.access_token,
        refresh_token: session.session.refresh_token,
        expires_in:    session.session.expires_in,
        user: {
          id:    session.user.id,
          email: session.user.email,
          role:  session.user.app_metadata?.role ?? 'MASTER_ADMIN',
        },
      },
    });

  } catch (error) {
    logger.error('[DevController] Unexpected error', { error: error.message });
    next(error);
  }
};








