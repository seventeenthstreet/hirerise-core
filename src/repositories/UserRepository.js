'use strict';

const BaseRepository = require('./BaseRepository');
const {
  AppError,
  ErrorCodes,
} = require('../middleware/errorHandler');

const PROTECTED_FIELDS = Object.freeze(
  new Set([
    // identity
    'uid',
    'id',
    'email',
    'role',
    'roles',
    'admin',

    // billing-owned
    'tier',
    'subscriptionStatus',
    'subscriptionProvider',
    'subscriptionId',

    // scoring / derived
    'chiScore',
    'onboardingCompleted',
    'resumeUploaded',

    // consent / lifecycle
    'consentGrantedAt',
    'consentVersion',
    'consentSource',
    'createdAt',
    'deletedAt',
  ])
);

// API aliases → canonical domain keys
const FIELD_MAP = Object.freeze({
  name: 'displayName',
  careerGoal: 'careerGoal',
  targetRole: 'targetRole',
  experienceYears: 'experienceYears',
});

class UserRepository extends BaseRepository {
  constructor() {
    super('users');
  }

  async updateProfile(userId, fields = {}) {
    if (!userId) {
      throw new AppError(
        'userId is required.',
        400,
        { userId },
        ErrorCodes.VALIDATION_ERROR
      );
    }

    const normalized = {};

    for (const [key, value] of Object.entries(fields)) {
      const canonicalKey = FIELD_MAP[key] ?? key;

      if (
        canonicalKey &&
        !PROTECTED_FIELDS.has(canonicalKey)
      ) {
        normalized[canonicalKey] = value;
      }
    }

    if (!Object.keys(normalized).length) {
      throw new AppError(
        'No valid fields provided for update.',
        400,
        { attemptedFields: Object.keys(fields) },
        ErrorCodes.VALIDATION_ERROR
      );
    }

    return this.update(userId, normalized);
  }
}

module.exports = Object.freeze(new UserRepository());