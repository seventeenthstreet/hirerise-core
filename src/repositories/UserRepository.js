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

    return this.update(userId, normalized, userId);
  }

  /**
   * G2 read/write-path fix (Phase 1):
   *
   * BaseRepository.update() unconditionally filters `.eq('soft_deleted', false)`.
   * The `public.users` table (000_initial_schema.sql) has never had a
   * `soft_deleted` column. PostgREST rejects an update filtered on a
   * column that does not exist on the target table, so every call to
   * userRepository.updateProfile() — not just the new name-capture path —
   * was failing at the database layer before this fix, regardless of which
   * profile field was being written.
   *
   * This override mirrors BaseRepository.update() exactly, minus the
   * soft_deleted filter, and is scoped to this repository only — it does
   * not change behavior for any other table that legitimately has
   * soft_deleted and relies on the base implementation.
   *
   * SECOND LATENT BUG, uncovered by live verification after the fix above:
   * BaseRepository.update()'s `userId = 'system'` default (which literally
   * every caller in this codebase relies on — no caller anywhere passes a
   * third argument) is written into the `updated_by` column. That column
   * is `uuid`-typed on `users` (000_initial_schema.sql), unlike 17 of the
   * 20 other `updated_by` columns in the schema, which are `text` and
   * happily accept the literal string 'system'. Writing 'system' into a
   * uuid column fails with an "invalid input syntax for type uuid" DB
   * error. This bug already existed before G2 — it was simply never
   * reached, because the soft_deleted filter above made every `users`
   * update fail first for an unrelated reason. Fixing the filter alone
   * exposed it.
   *
   * Fix: updateProfile() now passes the acting user's own id as the third
   * argument (self-service profile update — the actor IS the subject), so
   * `updated_by` receives a real uuid instead of the 'system' default.
   * BaseRepository's shared default is intentionally left untouched — this
   * fix is scoped to UserRepository only, since every other table using
   * that default has a text-typed updated_by column and is unaffected.
   */
  async update(id, updates = {}, userId = 'system') {
    if (!id) {
      throw new AppError(
        'Missing document id',
        400,
        { table: this.table },
        ErrorCodes.VALIDATION_ERROR
      );
    }

    const payload = {
      ...this._toSnakeCase(updates),
      updated_at: this._now(),
      updated_by: userId,
    };

    const { data: updated, error } = await this.db
      .from(this.table)
      .update(payload)
      .eq('id', id)
      .select('*')
      .single();

    this._throwDbError(error, 'update', { id });
    return this._normalize(updated);
  }
}

module.exports = Object.freeze(new UserRepository());