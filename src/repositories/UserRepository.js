'use strict';

const BaseRepository = require('./BaseRepository');
const {
  AppError,
  ErrorCodes,
} = require('../middleware/errorHandler');

const PROTECTED_FIELDS = new Set([
  'uid',
  'id',
  'email',
  'role',
  'roles',
  'admin',
  'plan',
  'tier',
  'planAmount',
  'plan_amount',
  'aiCreditsRemaining',
  'ai_credits_remaining',
  'reportUnlocked',
  'report_unlocked',
  'subscriptionStatus',
  'subscription_status',
  'subscriptionProvider',
  'subscription_provider',
  'subscriptionId',
  'subscription_id',
  'chiScore',
  'chi_score',
  'onboardingCompleted',
  'onboarding_completed',
  'resumeUploaded',
  'resume_uploaded',
  'consentGrantedAt',
  'consent_granted_at',
  'consentVersion',
  'consent_version',
  'consentSource',
  'consent_source',
  'createdAt',
  'created_at',
  'deletedAt',
  'deleted_at',
]);

// API request aliases → canonical camelCase domain keys
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

      if (!PROTECTED_FIELDS.has(canonicalKey)) {
        normalized[canonicalKey] = value;
      }
    }

    if (!Object.keys(normalized).length) {
      throw new AppError(
        'No valid fields provided for update.',
        400,
        null,
        ErrorCodes.VALIDATION_ERROR
      );
    }

    // BaseRepository handles snake_case conversion safely
    return this.update(userId, normalized);
  }
}

module.exports = new UserRepository();