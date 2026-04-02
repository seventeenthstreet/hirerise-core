'use strict';

/**
 * user.registration.service.js — FULLY FIXED (Production Safe)
 */

const { supabase } = require('../../config/supabase'); // ✅ FIXED
const logger = require('../../utils/logger');

// ─────────────────────────────────────────────
// ENSURE USER SEEDED
// ─────────────────────────────────────────────

async function ensureUserSeeded(userId, firebaseUser) {
  if (!userId) throw new Error('[UserRegistration] userId is required');

  const [usersResult, profileResult] = await Promise.all([
    supabase.from('users').select('id').eq('id', userId).maybeSingle(),
    supabase.from('user_profiles').select('id').eq('id', userId).maybeSingle() // ✅ FIXED
  ]);

  const usersExists = !!usersResult.data;
  const profileExists = !!profileResult.data;

  if (usersExists && profileExists) {
    logger.debug('[UserRegistration] User already seeded — skipping', { userId });
    return { created: false };
  }

  const now = new Date().toISOString();

  const writes = [];

  // ── users ─────────────────────────
  if (!usersExists) {
    writes.push(
      supabase
        .from('users')
        .upsert({
          id: userId,
          uid: userId,
          email: firebaseUser.email || '',
          display_name: firebaseUser.name || null,      // ✅ FIXED
          photo_url: firebaseUser.picture || null,      // ✅ FIXED
          tier: 'free',
          plan_amount: null,
          ai_credits_remaining: 0,
          report_unlocked: false,
          onboarding_completed: false,
          resume_uploaded: false,
          chi_score: null,
          subscription_status: 'inactive',
          subscription_provider: null,
          subscription_id: null,
          consent_granted_at: null,
          consent_version: null,
          consent_source: null,
          created_at: now,
          updated_at: now
        }, { onConflict: 'id' }) // ✅ FIXED
    );
  }

  // ── user_profiles ─────────────────────────
  if (!profileExists) {
    writes.push(
      supabase
        .from('user_profiles')
        .upsert({
          id: userId,
          uid: userId,
          display_name: firebaseUser.name || null,   // ✅ FIXED
          photo_url: firebaseUser.picture || null,   // ✅ FIXED
          email: firebaseUser.email || '',
          onboarding_completed: false,
          career_history: [],
          expected_role_ids: [],
          skills: [],
          current_city: null,
          current_salary_lpa: null,
          expected_salary_lpa: null,
          job_search_timeline: null,
          consent_granted_at: null,
          consent_version: null,
          consent_source: null,
          created_at: now,
          updated_at: now
        }, { onConflict: 'id' }) // ✅ FIXED
    );
  }

  const results = await Promise.all(writes);

  for (const result of results) {
    if (result.error) {
      logger.error('[UserRegistration] Seed write failed', {
        userId,
        error: result.error.message
      });
      throw new Error(result.error.message);
    }
  }

  logger.info('[UserRegistration] User seeded', {
    userId,
    createdUsers: !usersExists,
    createdProfile: !profileExists
  });

  return { created: true };
}

// ─────────────────────────────────────────────
// SYNC DISPLAY FIELDS
// ─────────────────────────────────────────────

async function syncProfileDisplayFields(userId, firebaseUser, existingFields = {}) {
  if (!userId) return false;

  const newDisplayName = firebaseUser.name || null;
  const newPhotoURL = firebaseUser.picture || null;

  if (
    newDisplayName === (existingFields.displayName ?? null) &&
    newPhotoURL === (existingFields.photoURL ?? null)
  ) {
    return false;
  }

  const now = new Date().toISOString();

  const payload = {
    display_name: newDisplayName, // ✅ FIXED
    photo_url: newPhotoURL,       // ✅ FIXED
    updated_at: now               // ✅ FIXED
  };

  const [usersResult, profileResult] = await Promise.all([
    supabase.from('users').update(payload).eq('id', userId),
    supabase.from('user_profiles').update(payload).eq('id', userId)
  ]);

  if (usersResult.error) {
    logger.warn('[UserRegistration] users sync failed', { userId, error: usersResult.error.message });
  }

  if (profileResult.error) {
    logger.warn('[UserRegistration] profile sync failed', { userId, error: profileResult.error.message });
  }

  logger.info('[UserRegistration] Display fields synced', {
    userId,
    to: { displayName: newDisplayName, photoURL: newPhotoURL }
  });

  return true;
}

// ─────────────────────────────────────────────

module.exports = {
  ensureUserSeeded,
  syncProfileDisplayFields
};
