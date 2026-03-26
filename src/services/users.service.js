'use strict';

/**
 * users.service.js — Business Logic for User Profile Operations
 *
 * Sits between users.routes.js (HTTP layer) and UserRepository (persistence layer).
 * The controller calls this service; the service calls the repository.
 * No Express objects (req / res) ever enter this layer.
 *
 * Responsibilities:
 *   - Accept validated, sanitised field maps from the controller
 *   - Enforce any business rules on top of validation (none currently)
 *   - Delegate persistence to UserRepository
 *   - Return a plain object suitable for the response envelope
 */

const userRepository = require('../repositories/UserRepository');
const logger         = require('../utils/logger');

// ─── Allowed editable fields ──────────────────────────────────────────────────
// Explicit allowlist — only these keys are forwarded to the repository.
// Adding a new editable field requires a conscious change here AND in the
// validation schema (users.routes.js). Belt-and-suspenders on top of the
// PROTECTED_FIELDS set in UserRepository.
const ALLOWED_PROFILE_FIELDS = new Set([
  'name',
  'location',
  'experienceYears',
  'targetRole',
  'bio',
  'user_type',   // ← ADDED: set by /choose-path via PATCH /users/me { user_type }
  'careerGoal',
]);

/**
 * updateUserProfile(userId, rawFields)
 *
 * Filters `rawFields` to only the allowed subset, then delegates to the
 * repository. Returns the updated profile document.
 *
 * @param {string} userId     — user ID (always from req.user.uid)
 * @param {object} rawFields  — Validated request body fields
 * @returns {Promise<object>} — Updated user document (Timestamps as ISO strings)
 */
async function updateUserProfile(userId, rawFields) {
  // Project only allowed keys — strips anything unexpected that slipped
  // past Zod / express-validator (extra defence-in-depth).
  const fieldsToUpdate = Object.fromEntries(
    Object.entries(rawFields).filter(([key]) => ALLOWED_PROFILE_FIELDS.has(key))
  );

  logger.info('[UsersService] Updating user profile', {
    userId,
    fields: Object.keys(fieldsToUpdate),
  });

  const updatedUser = await userRepository.updateProfile(userId, fieldsToUpdate);

  logger.info('[UsersService] User profile updated successfully', { userId });

  return updatedUser;
}

module.exports = { updateUserProfile };








