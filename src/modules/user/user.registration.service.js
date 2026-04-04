'use strict';

/**
 * src/modules/user/user.registration.service.js
 *
 * Production-safe Supabase-native user registration sync.
 * Delegates atomic seeding to the seed_user_and_profile SQL RPC so that
 * both tables are written in a single server-side transaction.
 */

const { supabase } = require('../../config/supabase');
const logger = require('../../utils/logger');

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function normalizeAuthUser(authUser = {}) {
  return {
    email: authUser.email || '',
    display_name: authUser.name || authUser.display_name || null,
    photo_url: authUser.picture || authUser.photo_url || null,
  };
}

// ─────────────────────────────────────────────
// ENSURE USER SEEDED  (via atomic RPC)
// ─────────────────────────────────────────────

/**
 * Seeds `users` and `user_profiles` atomically using the
 * `seed_user_and_profile` PostgreSQL RPC.
 *
 * Behavior:
 *  - Both rows are inserted in a single SQL transaction.
 *  - ON CONFLICT DO NOTHING — existing rows are never overwritten.
 *  - If the database raises any error the entire transaction rolls back.
 *
 * @param {string} userId  - UUID from Supabase Auth
 * @param {object} authUser - Raw auth payload (email, name/display_name, picture/photo_url)
 * @returns {{ created: boolean, created_user: boolean, created_profile: boolean }}
 */
async function ensureUserSeeded(userId, authUser = {}) {
  if (!userId) {
    throw new Error('[UserRegistration] userId is required');
  }

  const identity = normalizeAuthUser(authUser);

  const { data, error } = await supabase.rpc('seed_user_and_profile', {
    p_user_id:      userId,
    p_email:        identity.email,
    p_display_name: identity.display_name,
    p_photo_url:    identity.photo_url,
  });

  if (error) {
    logger.error('[UserRegistration] seed_user_and_profile RPC failed', {
      userId,
      error: error.message,
    });
    throw error;
  }

  const { created_user, created_profile } = data;
  const created = created_user || created_profile;

  if (!created) {
    logger.debug('[UserRegistration] User already seeded — skipping', { userId });
  } else {
    logger.info('[UserRegistration] User seeded via RPC', {
      userId,
      created_user,
      created_profile,
    });
  }

  return { created, created_user, created_profile };
}

// ─────────────────────────────────────────────
// SYNC DISPLAY FIELDS  (unchanged — fine as-is)
// ─────────────────────────────────────────────

/**
 * Syncs display_name / photo_url to both tables atomically using the
 * `sync_user_display_fields` PostgreSQL RPC.
 *
 * Behavior:
 *  - users        → display_name only (no photo_url column on that table)
 *  - user_profiles → display_name + photo_url
 *  - Both updates run in a single SQL transaction — any failure rolls back both.
 *  - Short-circuits early if values are unchanged (avoids unnecessary DB round-trip).
 *
 * @param {string} userId        - UUID from Supabase Auth
 * @param {object} authUser      - Raw auth payload
 * @param {object} existingFields - Current { display_name, photo_url } from DB
 * @returns {{ users_updated: boolean, profile_updated: boolean } | false}
 */
async function syncProfileDisplayFields(userId, authUser = {}, existingFields = {}) {
  if (!userId) return false;

  const identity = normalizeAuthUser(authUser);

  // Short-circuit: nothing changed, skip the DB round-trip entirely
  if (
    identity.display_name === (existingFields.display_name ?? null) &&
    identity.photo_url    === (existingFields.photo_url    ?? null)
  ) {
    logger.debug('[UserRegistration] Display fields unchanged — skipping sync', { userId });
    return false;
  }

  const { data, error } = await supabase.rpc('sync_user_display_fields', {
    p_user_id:      userId,
    p_display_name: identity.display_name,
    p_photo_url:    identity.photo_url,
  });

  if (error) {
    logger.error('[UserRegistration] sync_user_display_fields RPC failed', {
      userId,
      error: error.message,
    });
    throw error;
  }

  const { users_updated, profile_updated } = data;

  logger.info('[UserRegistration] Display fields synced via RPC', {
    userId,
    users_updated,
    profile_updated,
    to: { display_name: identity.display_name, photo_url: identity.photo_url },
  });

  return { users_updated, profile_updated };
}

module.exports = {
  ensureUserSeeded,
  syncProfileDisplayFields,
};