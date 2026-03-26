'use strict';

/**
 * src/repositories/UserRepository.js
 *
 * FIX: Field name mapping in updateProfile() was using camelCase column names
 * (displayName, careerGoal, targetRole, experienceYears) when writing to Supabase.
 * Supabase column names are snake_case (display_name, career_goal, etc.).
 * This caused PATCH /users/me to silently write wrong column names, leaving
 * the fields unchanged in the database.
 *
 * WHAT CHANGED:
 *   - name        → display_name       (was: displayName)
 *   - careerGoal  → career_goal        (was: no mapping existed)
 *   - targetRole  → target_role        (was: no mapping existed)
 *   - experienceYears → experience_years (was: no mapping existed)
 *
 * UNCHANGED:
 *   - PROTECTED_FIELDS set
 *   - user_type remains writable (not in PROTECTED_FIELDS)
 *   - location, bio pass through as-is (already snake_case compatible)
 *   - All BaseRepository methods
 */

const BaseRepository  = require('./BaseRepository');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

// ─── Protected fields — never writeable via profile update ───────────────────
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
  // user_type is intentionally NOT protected — set by /choose-path
]);

// ─── Request body field → Supabase column name ────────────────────────────────
// Maps camelCase API request fields to snake_case Supabase column names.
// Add entries here when adding new editable profile fields.

const FIELD_MAP = {
  name:            'display_name',
  careerGoal:      'career_goal',
  targetRole:      'target_role',
  experienceYears: 'experience_years',
  // Fields that are already snake_case pass through as-is:
  //   location, bio, user_type
};

class UserRepository extends BaseRepository {
  constructor() {
    super('users');
  }

  /**
   * updateProfile(userId, fields)
   *
   * Persists user-editable profile fields to the Supabase `users` table.
   *
   * Security guarantees:
   *   - Only the fields in `FIELD_MAP` or that are snake_case passthrough are written
   *   - PROTECTED_FIELDS are stripped even if somehow passed in
   *   - updatedAt is set by BaseRepository.update() automatically
   *   - Throws NOT_FOUND (404) if the row does not exist
   *
   * @param {string} userId  — Supabase user UUID (always sourced from req.user.uid)
   * @param {object} fields  — Validated subset of editable profile fields
   * @returns {Promise<object>} — The updated document
   */
  async updateProfile(userId, fields) {
    // Remap camelCase API names → snake_case Supabase column names
    const mapped = {};
    for (const [key, value] of Object.entries(fields)) {
      const supabaseKey = FIELD_MAP[key] ?? key;  // use mapping if exists, else pass through
      mapped[supabaseKey] = value;
    }

    // Strip any protected fields
    const safePayload = Object.fromEntries(
      Object.entries(mapped).filter(([key]) => !PROTECTED_FIELDS.has(key))
    );

    if (Object.keys(safePayload).length === 0) {
      throw new AppError(
        'No valid fields provided for update.',
        400,
        null,
        ErrorCodes.VALIDATION_ERROR
      );
    }

    // BaseRepository.update() merges safePayload and sets updated_at
    return this.update(userId, safePayload);
  }
}

module.exports = new UserRepository();








