'use strict';

/**
 * src/modules/user/user.registration.service.js
 *
 * Patch 32: Final production-hardened identity bootstrap RPC layer
 * - strict AppError validation
 * - DTO shape normalization symmetry
 * - deterministic display sync
 */

const { supabase } = require('../../config/supabase');
const {
  AppError,
  ErrorCodes,
} = require('../../middleware/errorHandler');
const logger = require('../../utils/logger');

const MAX_EMAIL_LENGTH = 320;
const MAX_NAME_LENGTH = 160;
const MAX_PHOTO_URL_LENGTH = 500;

function requireUserId(userId) {
  if (!userId) {
    throw new AppError(
      'userId is required',
      400,
      { userId },
      ErrorCodes.VALIDATION_ERROR
    );
  }
}

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

function normalizeAuthUser(authUser = {}) {
  const meta = authUser.user_metadata || {};

  const email = normalizeString(
    authUser.email || meta.email,
    MAX_EMAIL_LENGTH
  );

  const display_name = normalizeString(
    authUser.name ||
      authUser.display_name ||
      authUser.displayName ||
      authUser.full_name ||
      meta.full_name ||
      meta.name,
    MAX_NAME_LENGTH
  );

  const rawPhotoUrl = normalizeString(
    authUser.picture ||
      authUser.photo_url ||
      authUser.photoUrl ||
      authUser.avatar_url ||
      meta.avatar_url ||
      meta.picture,
    MAX_PHOTO_URL_LENGTH
  );

  const photo_url = isValidHttpUrl(rawPhotoUrl)
    ? rawPhotoUrl
    : null;

  return Object.freeze({
    email: email || '',
    display_name,
    photo_url,
  });
}

function normalizeRpcObject(data) {
  if (!data) return {};
  if (Array.isArray(data)) return data[0] || {};
  if (typeof data !== 'object') return {};
  return data;
}

async function safeRpc(rpcName, payload, userId) {
  const { data, error } = await supabase.rpc(rpcName, payload);

  if (error) {
    logger.error('[UserRegistration] RPC failed', {
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

async function ensureUserSeeded(userId, authUser = {}) {
  requireUserId(userId);

  const identity = normalizeAuthUser(authUser);

  const payload = await safeRpc(
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

  logger[created ? 'info' : 'debug'](
    created
      ? '[UserRegistration] User seeded via RPC'
      : '[UserRegistration] User already seeded — skipping',
    {
      userId,
      created_user,
      created_profile,
    }
  );

  return {
    created,
    created_user,
    created_profile,
    identity,
  };
}

async function syncProfileDisplayFields(
  userId,
  authUser = {},
  existingFields = {}
) {
  requireUserId(userId);

  const identity = normalizeAuthUser(authUser);

  const currentDisplayName = normalizeString(
    existingFields?.display_name ??
      existingFields?.displayName,
    MAX_NAME_LENGTH
  );

  const currentPhotoUrl = isValidHttpUrl(
    existingFields?.photo_url ??
      existingFields?.photoUrl
  )
    ? existingFields?.photo_url ??
      existingFields?.photoUrl
    : null;

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
      identity,
    };
  }

  const payload = await safeRpc(
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
    }
  );

  return {
    updated: users_updated || profile_updated,
    users_updated,
    profile_updated,
    identity,
  };
}

module.exports = Object.freeze({
  ensureUserSeeded,
  syncProfileDisplayFields,
});