'use strict';

/**
 * users.service.js — Business Logic for User Profile Operations
 *
 * Service layer between HTTP controllers and UserRepository.
 * Accepts validated plain objects only.
 */

const userRepository = require('../repositories/UserRepository');
const logger = require('../utils/logger');

const ALLOWED_PROFILE_FIELDS = Object.freeze(
  new Set([
    'name',
    'location',
    'experienceYears',
    'targetRole',
    'bio',
    'user_type',
    'careerGoal',
  ])
);

function sanitizeProfileFields(rawFields = {}) {
  if (!rawFields || typeof rawFields !== 'object') {
    return {};
  }

  return Object.entries(rawFields).reduce((acc, [key, value]) => {
    if (ALLOWED_PROFILE_FIELDS.has(key) && value !== undefined) {
      acc[key] = value;
    }
    return acc;
  }, {});
}

/**
 * Update user profile
 *
 * @param {string} userId
 * @param {object} rawFields
 * @returns {Promise<object>}
 */
async function updateUserProfile(userId, rawFields = {}) {
  if (!userId) {
    throw new Error('updateUserProfile: userId is required');
  }

  const fieldsToUpdate = sanitizeProfileFields(rawFields);

  const updateKeys = Object.keys(fieldsToUpdate);

  if (updateKeys.length === 0) {
    logger.warn('[UsersService] Empty profile update ignored', {
      userId,
    });

    return userRepository.findById(userId);
  }

  logger.info('[UsersService] Updating user profile', {
    userId,
    fields: updateKeys,
    fieldCount: updateKeys.length,
  });

  const updatedUser = await userRepository.updateProfile(
    userId,
    fieldsToUpdate
  );

  logger.info('[UsersService] User profile updated successfully', {
    userId,
    updatedFields: updateKeys,
  });

  return updatedUser;
}

module.exports = {
  updateUserProfile,
};