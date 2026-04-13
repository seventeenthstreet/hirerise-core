'use strict';

/**
 * src/modules/user/user.registration.service.js
 *
 * Wave 4 Patch 29B
 * Production-safe identity bootstrap RPC layer
 */

const { supabase } = require('../../config/supabase');
const logger = require('../../utils/logger');

const MAX_EMAIL_LENGTH = 320;
const MAX_NAME_LENGTH = 160;
const MAX_PHOTO_URL_LENGTH = 500;

function normalizeString(value, maxLength = null) {
  if (value == null) return null;

  const cleaned = String(value).trim();

  if (!cleaned) return null;

  return maxLength
    ? cleaned.slice(0, maxLength)
    : cleaned;
}

function isValidHttpUrl(value) {
  if (!value) return false;

  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

/**
 * Normalize auth payloads from:
 * - Supabase auth
 * - OAuth providers
 * - legacy JWT payloads
 */
function normalizeAuthUser(authUser = {}) {
  const meta = authUser.user_metadata || {};

  const email = normalizeString(
    authUser.email || meta.email,
    MAX_EMAIL_LENGTH
  );

  const display_name = normalizeString(
    authUser.name ||
      authUser.display_name ||
      authUser.full_name ||
      meta.full_name ||
      meta.name,
    MAX_NAME_LENGTH
  );

  const rawPhotoUrl = normalizeString(
    authUser.picture ||
      authUser.photo_url ||
      authUser.avatar_url ||
      meta.avatar_url ||
      meta.picture,
    MAX_PHOTO_URL_LENGTH
  );

  const photo_url = isValidHttpUrl(rawPhotoUrl)
    ? rawPhotoUrl
    : null;

  return {
    email: email || '',
    display_name,
    photo_url,
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

async function executeRpc(rpcName, payload, userId) {
  const { data, error } = await supabase.rpc(rpcName, payload);

  if (error) {
    logger.error(`[UserRegistration] ${rpcName} RPC failed`, {
      rpc: rpcName,
      userId,
      code: error.code,
      details: error.details,
      hint: error.hint,
      error: error.message,
    });
    throw error;
  }

  return normalizeRpcObject(data);
}

/**
 * Atomic user + profile seed
 */
async function ensureUserSeeded(userId, authUser = {}) {
  if (!userId) {
    throw new Error('[UserRegistration] userId is required');
  }

  const identity = normalizeAuthUser(authUser);

  const payload = await executeRpc(
    'seed_user_and_profile',
    {
      p_user_id: userId,
      p_email: identity.email,
      p_display_name: identity.display_name,
      p_photo_url: identity.photo_url,
    },
    userId
  );

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

  return {
    created,
    created_user,
    created_profile,
    identity,
  };
}

/**
 * Atomic display sync
 */
async function syncProfileDisplayFields(
  userId,
  authUser = {},
  existingFields = {}
) {
  if (!userId) {
    throw new Error('[UserRegistration] userId is required');
  }

  const identity = normalizeAuthUser(authUser);

  const currentDisplayName =
    existingFields?.display_name ?? null;
  const currentPhotoUrl =
    existingFields?.photo_url ?? null;

  if (
    identity.display_name === currentDisplayName &&
    identity.photo_url === currentPhotoUrl
  ) {
    logger.debug(
      '[UserRegistration] Display fields unchanged — skipping sync',
      { userId }
    );

    return {
      updated: false,
      users_updated: false,
      profile_updated: false,
    };
  }

  const payload = await executeRpc(
    'sync_user_display_fields',
    {
      p_user_id: userId,
      p_display_name: identity.display_name,
      p_photo_url: identity.photo_url,
    },
    userId
  );

  const users_updated = Boolean(payload.users_updated);
  const profile_updated = Boolean(payload.profile_updated);

  logger.info(
    '[UserRegistration] Display fields synced via RPC',
    {
      userId,
      users_updated,
      profile_updated,
      to: {
        display_name: identity.display_name,
        photo_url: identity.photo_url,
      },
    }
  );

  return {
    updated: users_updated || profile_updated,
    users_updated,
    profile_updated,
    identity,
  };
}

module.exports = {
  ensureUserSeeded,
  syncProfileDisplayFields,
};