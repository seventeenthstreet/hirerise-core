'use strict';

/**
 * src/modules/user/user.registration.service.js
 *
 * Wave 1 hardened identity bootstrap RPC layer
 */

const { supabase } = require('../../config/supabase');
const logger = require('../../utils/logger');

/**
 * Normalize auth payloads from:
 * - Supabase auth
 * - OAuth providers
 * - legacy JWT payloads
 */
function normalizeAuthUser(authUser = {}) {
  const meta = authUser.user_metadata || {};

  return {
    email: String(
      authUser.email ||
      meta.email ||
      ''
    ).trim(),
    display_name:
      authUser.name ||
      authUser.display_name ||
      authUser.full_name ||
      meta.full_name ||
      meta.name ||
      null,
    photo_url:
      authUser.picture ||
      authUser.photo_url ||
      authUser.avatar_url ||
      meta.avatar_url ||
      meta.picture ||
      null,
  };
}

/**
 * Normalize RPC object/array/null payloads
 */
function normalizeRpcObject(data) {
  if (!data) return {};

  if (Array.isArray(data)) {
    return data[0] || {};
  }

  if (typeof data !== 'object') {
    return {};
  }

  return data;
}

/**
 * Atomic seed
 */
async function ensureUserSeeded(userId, authUser = {}) {
  if (!userId) {
    throw new Error('[UserRegistration] userId is required');
  }

  const identity = normalizeAuthUser(authUser);

  if (identity.email.length > 320) {
    throw new Error('[UserRegistration] email exceeds max length');
  }

  if (identity.display_name && identity.display_name.length > 160) {
    identity.display_name = identity.display_name.slice(0, 160);
  }

  if (identity.photo_url && identity.photo_url.length > 500) {
    identity.photo_url = identity.photo_url.slice(0, 500);
  }

  const { data, error } = await supabase.rpc('seed_user_and_profile', {
    p_user_id: userId,
    p_email: identity.email,
    p_display_name: identity.display_name,
    p_photo_url: identity.photo_url,
  });

  if (error) {
    logger.error('[UserRegistration] seed_user_and_profile RPC failed', {
      rpc: 'seed_user_and_profile',
      userId,
      code: error.code,
      details: error.details,
      error: error.message,
    });
    throw error;
  }

  const payload = normalizeRpcObject(data);

  const created_user = Boolean(payload.created_user);
  const created_profile = Boolean(payload.created_profile);
  const created = created_user || created_profile;

  if (!created) {
    logger.debug(
      '[UserRegistration] User already seeded — skipping',
      { userId }
    );
  } else {
    logger.info('[UserRegistration] User seeded via RPC', {
      userId,
      created_user,
      created_profile,
    });
  }

  return { created, created_user, created_profile };
}

/**
 * Atomic display sync
 */
async function syncProfileDisplayFields(
  userId,
  authUser = {},
  existingFields = {}
) {
  if (!userId) return false;

  const identity = normalizeAuthUser(authUser);

  if (
    identity.display_name === (existingFields.display_name ?? null) &&
    identity.photo_url === (existingFields.photo_url ?? null)
  ) {
    logger.debug(
      '[UserRegistration] Display fields unchanged — skipping sync',
      { userId }
    );
    return false;
  }

  const { data, error } = await supabase.rpc(
    'sync_user_display_fields',
    {
      p_user_id: userId,
      p_display_name: identity.display_name,
      p_photo_url: identity.photo_url,
    }
  );

  if (error) {
    logger.error(
      '[UserRegistration] sync_user_display_fields RPC failed',
      {
        rpc: 'sync_user_display_fields',
        userId,
        code: error.code,
        details: error.details,
        error: error.message,
      }
    );
    throw error;
  }

  const payload = normalizeRpcObject(data);

  const users_updated = Boolean(payload.users_updated);
  const profile_updated = Boolean(payload.profile_updated);

  logger.info('[UserRegistration] Display fields synced via RPC', {
    userId,
    users_updated,
    profile_updated,
    to: {
      display_name: identity.display_name,
      photo_url: identity.photo_url,
    },
  });

  return { users_updated, profile_updated };
}

module.exports = {
  ensureUserSeeded,
  syncProfileDisplayFields,
};