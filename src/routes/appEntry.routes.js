/**
 * appEntry.routes.js
 *
 * Registers:
 *   GET /api/v1/app-entry   — bootstrap cache-warm + profile guard
 *   GET /api/v1/users/me    — full profile fetch (used by fetchUser in frontend)
 *
 * ROOT CAUSE FIX:
 *   Neither of these routes existed in hirerise-core/src/server.js.
 *   The frontend's warmAppEntry() calls /api/v1/app-entry fire-and-forget
 *   during the boot sequence. If this returns 404 (or hangs), the hydration
 *   sequence stalls: warmAppEntry() awaits the drain of the response body,
 *   and a 404 from the Next.js proxy produces a response that IS drained, but
 *   the subsequent fetchUser() call to /api/v1/users/me ALSO 404s, causing
 *   fetchUser to return null → page.tsx routes to /direction regardless of
 *   whether the user has already completed onboarding. On page refresh this
 *   causes an infinite /direction redirect loop.
 *
 *   Additionally, the existing auth.middleware.js uses Firebase Admin to
 *   verify JWTs. The frontend sends Supabase JWTs — Firebase rejects them
 *   with a 401, so no authenticated request ever succeeds.
 *
 * ARCHITECTURE:
 *   Both routes are protected by verifySupabaseToken middleware.
 *   Route handlers are intentionally thin: auth → service → response.
 *
 * MOUNT IN server.js:
 *   const appEntryRoutes = require('./routes/appEntry.routes');
 *   app.use(`${API_PREFIX}`, appEntryRoutes);
 *
 * (The routes are mounted at API_PREFIX, not API_PREFIX/app-entry, so both
 *  /api/v1/app-entry and /api/v1/users/me are served from this file.)
 */

'use strict';

const express = require('express');
const { verifySupabaseToken } = require('../middleware/supabaseAuth.middleware');
const { ensureProfile, getProfileByUserId } = require('../services/userProfile.service');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/app-entry
//
// Purpose:
//   1. Verify the user's JWT is valid (handled by verifySupabaseToken).
//   2. Ensure a profile row exists — create a minimal one if not (handles
//      the new OAuth user case where the handle_new_user() trigger may not
//      have fired yet).
//   3. Return 200 so the frontend's warmAppEntry() can drain the body and
//      release the TCP connection, allowing fetchUser() to proceed.
//
// The frontend (useAppHydration.ts) treats this as fire-and-forget cache warming.
// The response body is intentionally minimal — the frontend only cares that
// this resolves with a 2xx so the connection is released before fetchUser().
//
// Errors:
//   401 — invalid/missing JWT (handled by verifySupabaseToken middleware)
//   500 — unexpected DB error (should not block the frontend; warmAppEntry absorbs errors)
// ─────────────────────────────────────────────────────────────────────────────

router.get('/app-entry', verifySupabaseToken, async (req, res) => {
  const { uid, email } = req.user;

  // DEBUG LOG — remove after confirming the route is reachable in your environment
  console.info('[app-entry] Bootstrap request received', {
    uid,
    email,
    ip: req.ip,
    timestamp: new Date().toISOString(),
  });

  try {
    // Ensure a profile row exists. For new users where the Supabase
    // handle_new_user() trigger has not yet created the row, this creates
    // a minimal placeholder so /users/me returns a row immediately.
    const name = req.supabaseUser?.user_metadata?.full_name
              ?? req.supabaseUser?.user_metadata?.name
              ?? null;

    await ensureProfile(uid, email, name);

    console.info('[app-entry] Bootstrap complete', { uid });

    return res.status(200).json({
      success: true,
      message: 'bootstrap ok',
    });
  } catch (err) {
    // app-entry is cache-warm only — the frontend absorbs all non-401 errors.
    // Log the error for observability but return 200 so warmAppEntry() doesn't
    // block the hydration sequence: fetchUser() will get a 404 and surface the
    // real error through the profile-missing path (routing to /direction).
    console.error('[app-entry] Bootstrap error (non-fatal for client):', {
      uid,
      error: err?.message ?? String(err),
      code:  err?.code,
    });

    // Return 500 for proper monitoring; the frontend absorbs it and continues.
    return res.status(500).json({
      success: false,
      error:   'BOOTSTRAP_ERROR',
      message: 'Session bootstrap encountered an error',
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/users/me
//
// Purpose:
//   Returns the authenticated user's full profile.
//   This is the response that fetchUser() in useAppHydration.ts parses to
//   populate AppContext.user — the central user state the entire app depends on.
//
// Response shape (must match what fetchUser() expects):
//   {
//     success: true,
//     data: {
//       user:    { id, name, email, user_type, ... },   // required by fetchUser
//       credits: { ... } | null,                         // optional
//       quota:   { ... } | null,                         // optional
//     }
//   }
//
//   NOTE: The frontend's fetchUser() reads payload.user (via apiClient/apiParser).
//   The exact envelope shape depends on your api-parser.ts response unwrapping.
//   Adjust the response structure below to match your parseApiResponse() logic.
//
// Errors:
//   401 — invalid/missing JWT
//   404 — no profile row (expected for brand-new users; frontend routes to /direction)
//   500 — unexpected DB error
// ─────────────────────────────────────────────────────────────────────────────

router.get('/users/me', verifySupabaseToken, async (req, res) => {
  const { uid } = req.user;

  // DEBUG LOG — remove after verifying correct behavior in staging
  console.info('[users/me] Profile fetch', { uid, timestamp: new Date().toISOString() });

  try {
    const profile = await getProfileByUserId(uid);

    if (!profile) {
      // No profile row — new user who hasn't completed direction selection yet.
      // Return 404 so fetchUser() in useAppHydration.ts returns null,
      // and page.tsx routes the user to /direction.
      console.info('[users/me] No profile found for', uid);
      return res.status(404).json({
        success: false,
        error:   'NOT_FOUND',
        message: 'User profile not found',
      });
    }

    console.info('[users/me] Profile found', {
      uid,
      user_type: profile.user_type,
    });

    // ── Response envelope ─────────────────────────────────────────────────
    // The frontend's apiClient + parseApiResponse unwraps the `data` field.
    // fetchUser() then reads payload.user from the unwrapped object.
    // Adjust this envelope shape if your api-parser uses a different key.
    return res.status(200).json({
      success: true,
      data: {
        user: {
          id:                              profile.id,
          name:                            profile.name           ?? null,
          email:                           profile.email          ?? req.user.email,
          user_type:                       profile.user_type      ?? null,
          professional_onboarding_complete: profile.professional_onboarding_complete ?? false,
          student_onboarding_complete:      profile.student_onboarding_complete      ?? false,
          onboarding_completed:             profile.onboarding_completed             ?? false,
          resume_uploaded:                  profile.resume_uploaded                  ?? false,
          created_at:                       profile.created_at,
          updated_at:                       profile.updated_at,
        },
        credits: null,  // populate from your billing/credits table if applicable
        quota:   null,  // populate from your quota table if applicable
      },
    });
  } catch (err) {
    console.error('[users/me] Unexpected error:', {
      uid,
      error: err?.message ?? String(err),
      code:  err?.code,
    });

    return res.status(500).json({
      success: false,
      error:   'INTERNAL_ERROR',
      message: 'Failed to fetch user profile',
    });
  }
});

module.exports = router;