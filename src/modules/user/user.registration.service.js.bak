'use strict';

/**
 * user.registration.service.js
 *
 * FIX G-02: User Profile Seeding at Auth Time
 * ============================================
 *
 * PROBLEM:
 *   Before this fix, neither users/{uid} nor userProfiles/{uid} were ever
 *   created at auth time. They only came into existence when:
 *     - users/{uid}       → GET /users/me (lazy-create on first profile fetch)
 *     - userProfiles/{uid} → POST /onboarding/career-intent (Track B only)
 *
 *   This caused a silent race condition in persistCompletionIfReady():
 *     1. User completes Track A (education + career report)
 *     2. persistCompletionIfReady reads userProfiles/{uid} → doc DOESN'T EXIST
 *     3. evaluateCompletion sees profile = {} → trackB = false
 *     4. onboardingCompleted is NEVER written even if Track B is later done
 *        — because Track A's completion check already ran and Track B's write
 *          never re-triggers the Track A check
 *
 *   Additionally, Track A can fire persistCompletionIfReady before ANY userProfiles
 *   doc exists, meaning users can get stuck with onboardingCompleted=false forever
 *   even after completing both tracks, if the tracks complete in A→B order.
 *
 * SOLUTION:
 *   ensureUserSeeded(userId, firebaseUser) — idempotent, called from:
 *     1. POST /api/v1/users/register  — explicit first-login call from frontend
 *     2. GET  /api/v1/app-entry       — as a safety net on every post-auth entry
 *
 *   Uses Firestore batch with set(merge:true) so:
 *     - Safe to call multiple times (idempotent)
 *     - Never overwrites existing data
 *     - Creates both docs atomically in a single round-trip
 *
 * COLLECTIONS SEEDED:
 *   users/{userId}         — billing profile, credits, tier reference
 *   userProfiles/{userId}  — career/onboarding profile (MUST exist before Track A)
 */

const { db }        = require('../../config/supabase');
const { FieldValue } = require('../../config/supabase');
const logger         = require('../../utils/logger');

/**
 * ensureUserSeeded(userId, firebaseUser)
 *
 * Idempotently ensures both users/{userId} and userProfiles/{userId} exist
 * in Firestore. Uses set(merge:true) so existing data is never overwritten.
 *
 * @param {string} userId        - user ID
 * @param {object} firebaseUser  - Decoded Firebase token (req.user)
 * @returns {Promise<{ created: boolean }>}
 *   created: true  → at least one doc was newly written
 *   created: false → both docs already existed (no-op)
 */
async function ensureUserSeeded(userId, firebaseUser) {
  if (!userId) throw new Error('[UserRegistration] userId is required');

  // Check both docs exist in parallel — single round-trip
  const [usersSnap, profileSnap] = await Promise.all([
    db.collection('users').doc(userId).get(),
    db.collection('userProfiles').doc(userId).get(),
  ]);

  const usersExists   = usersSnap.exists;
  const profileExists = profileSnap.exists;

  // Both already exist — fast path, no writes needed
  if (usersExists && profileExists) {
    logger.debug('[UserRegistration] User already seeded — skipping', { userId });
    return { created: false };
  }

  const now = FieldValue.serverTimestamp();

  const batch = db.batch();

  // ── users/{userId} ──────────────────────────────────────────────────────────
  // Billing profile. Only seed if missing — never overwrite existing tier/credits.
  if (!usersExists) {
    batch.set(db.collection('users').doc(userId), {
      uid:                  userId,
      email:                firebaseUser.email    || '',
      displayName:          firebaseUser.name     || null,
      photoURL:             firebaseUser.picture  || null,
      tier:                 'free',
      planAmount:           null,
      aiCreditsRemaining:   0,
      reportUnlocked:       false,
      onboardingCompleted:  false,
      resumeUploaded:       false,
      chiScore:             null,
      subscriptionStatus:   'inactive',
      subscriptionProvider: null,
      subscriptionId:       null,
      // PROMPT-2: consent fields — null until POST /onboarding/consent is called
      consentGrantedAt:     null,
      consentVersion:       null,
      consentSource:        null,
      createdAt:            now,
      updatedAt:            now,
    }, { merge: true });
  }

  // ── userProfiles/{userId} ───────────────────────────────────────────────────
  // Career/onboarding profile.
  // CRITICAL: This MUST exist before Track A runs persistCompletionIfReady.
  // Without it, evaluateCompletion always sees profile={} → trackB=false.
  if (!profileExists) {
    batch.set(db.collection('userProfiles').doc(userId), {
      uid:                 userId,
      displayName:         firebaseUser.name    || null,
      photoURL:            firebaseUser.picture || null,
      email:               firebaseUser.email   || '',
      onboardingCompleted: false,
      careerHistory:       [],
      expectedRoleIds:     [],
      skills:              [],
      currentCity:         null,
      currentSalaryLPA:    null,
      expectedSalaryLPA:   null,
      jobSearchTimeline:   null,
      // PROMPT-2: consent fields — null until POST /onboarding/consent is called
      consentGrantedAt:    null,
      consentVersion:      null,
      consentSource:       null,
      createdAt:           now,
      updatedAt:           now,
    }, { merge: true });
  }

  await batch.commit();

  logger.info('[UserRegistration] User seeded', {
    userId,
    createdUsers:   !usersExists,
    createdProfile: !profileExists,
  });

  return { created: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// FIX G-09: displayName / photoURL sync
// ─────────────────────────────────────────────────────────────────────────────

/**
 * syncProfileDisplayFields(userId, firebaseUser)
 *
 * FIX G-09 — Keep displayName and photoURL current in both Firestore docs.
 *
 * PROBLEM:
 *   ensureUserSeeded() writes displayName + photoURL exactly once at first-login,
 *   from the Firebase ID token claims (name, picture). After that:
 *     - If the user updates their Google/email profile, the token claims update.
 *     - Firestore docs never see the change.
 *     - Dashboard, CV header, and any server-side personalization show stale data.
 *
 * FIX:
 *   Called on every GET /app-entry (the single post-auth routing authority).
 *   Uses set(merge:true) with ONLY the display fields — never touches tier, credits,
 *   onboardingCompleted, or any other field. No data loss risk.
 *
 *   Guard: if both fields are unchanged, skip the write to avoid unnecessary
 *   Firestore writes on every app load. This requires a read first, but
 *   app-entry already reads userProfiles — the caller passes the existing values
 *   so we can diff before writing.
 *
 * @param {string} userId
 * @param {object} firebaseUser   — req.user (decoded Firebase ID token)
 * @param {object} existingFields — { displayName, photoURL } from current Firestore doc
 * @returns {Promise<boolean>}     true if a write was made, false if skipped
 */
async function syncProfileDisplayFields(userId, firebaseUser, existingFields = {}) {
  if (!userId) return false;

  const newDisplayName = firebaseUser.name    || null;
  const newPhotoURL    = firebaseUser.picture || null;

  // Fast exit — nothing has changed, no write needed
  if (
    newDisplayName === (existingFields.displayName ?? null) &&
    newPhotoURL    === (existingFields.photoURL    ?? null)
  ) {
    return false;
  }

  const now   = new Date();
  const batch = db.batch();

  const displayPayload = {
    displayName: newDisplayName,
    photoURL:    newPhotoURL,
    updatedAt:   now,
  };

  // Update both docs atomically — dashboard reads from userProfiles,
  // billing/auth reads from users.
  batch.set(db.collection('users').doc(userId),        displayPayload, { merge: true });
  batch.set(db.collection('userProfiles').doc(userId), displayPayload, { merge: true });

  await batch.commit();

  logger.info('[UserRegistration] Display fields synced', {
    userId,
    from: { displayName: existingFields.displayName, photoURL: existingFields.photoURL },
    to:   { displayName: newDisplayName, photoURL: newPhotoURL },
  });

  return true;
}

module.exports = { ensureUserSeeded, syncProfileDisplayFields };









