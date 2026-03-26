'use strict';

/**
 * abandonedOnboarding.worker.js
 *
 * MIGRATION: Removed require('../config/supabase') and the split import of
 * FieldValue from supabase. All DB access now uses the direct Supabase
 * client via config/supabase.
 *
 * Query changes:
 *   OLD: db.collection('onboardingProgress').where('lastActiveAt', '<', cutoffDate).get()
 *   NEW: supabase.from('onboarding_progress').select('*').lt('last_active_at', cutoffISO)
 *
 *   OLD: db.batch() + batch.set(ref, { abandonedAt: FieldValue.serverTimestamp() }, { merge: true })
 *   NEW: supabase.from('onboarding_progress').upsert([...], { onConflict: 'id' })
 *
 * Schema note: Postgres column names are snake_case versions of the Firestore
 * field names (e.g. lastActiveAt → last_active_at).
 */

const supabase   = require('../config/supabase');
const logger     = require('../utils/logger');
const BaseWorker = require('./shared/BaseWorker');

const ABANDON_THRESHOLD_DAYS = parseInt(process.env.ONBOARDING_ABANDON_DAYS || '7', 10);
const BATCH_SIZE             = 400;

class AbandonedOnboardingWorker extends BaseWorker {
  constructor() {
    super('abandoned-onboarding');
  }

  /**
   * Core job logic — called by BaseWorker.run() after idempotency check.
   *
   * @param {{ cutoffDate: Date }} payload
   * @returns {Promise<{ scanned: number, stamped: number, skipped: number, durationMs: number }>}
   */
  async process({ cutoffDate }) {
    const jobStart = Date.now();

    logger.info('[AbandonedOnboardingWorker] Starting job', {
      thresholdDays: ABANDON_THRESHOLD_DAYS,
      cutoff:        cutoffDate.toISOString(),
    });

    // Query: not completed, last activity before cutoff.
    // Filter onboarding_completed client-side (same logic as original) to keep
    // the index simple and avoid a composite index requirement.
    const { data: rows, error } = await supabase
      .from('onboarding_progress')
      .select('*')
      .lt('last_active_at', cutoffDate.toISOString());

    if (error) {
      throw new Error(`[AbandonedOnboardingWorker] Query failed: ${error.message}`);
    }

    const docs = (rows ?? []).filter(row => !row.onboarding_completed);

    if (docs.length === 0) {
      logger.info('[AbandonedOnboardingWorker] No inactive docs found', {
        cutoff: cutoffDate.toISOString(),
      });
      return { scanned: 0, stamped: 0, skipped: 0, durationMs: Date.now() - jobStart };
    }

    const scanned = docs.length;
    let stamped   = 0;
    let skipped   = 0;

    const now = new Date().toISOString();

    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
      const chunk = docs.slice(i, i + BATCH_SIZE);

      // Collect rows that haven't been stamped yet
      const toStamp = [];
      for (const row of chunk) {
        if (row.abandoned_at) {
          // Idempotency: already stamped, don't overwrite abandonedAt
          skipped++;
          continue;
        }
        toStamp.push({
          id:                row.id,
          abandoned_at:      now,
          abandoned_at_step: row.last_active_step || 'unknown',
        });
        stamped++;
      }

      if (toStamp.length > 0) {
        const { error: upsertErr } = await supabase
          .from('onboarding_progress')
          .upsert(toStamp, { onConflict: 'id' });

        if (upsertErr) {
          throw new Error(`[AbandonedOnboardingWorker] Batch upsert failed: ${upsertErr.message}`);
        }
      }

      logger.debug('[AbandonedOnboardingWorker] Batch committed', {
        batchIndex: Math.floor(i / BATCH_SIZE),
        batchSize:  chunk.length,
        stamped:    toStamp.length,
      });
    }

    const durationMs = Date.now() - jobStart;
    logger.info('[AbandonedOnboardingWorker] Job complete', { scanned, stamped, skipped, durationMs });
    return { scanned, stamped, skipped, durationMs };
  }

  /**
   * Backward-compatible wrapper — existing cron call sites use runJob() unchanged.
   *
   * @returns {Promise<{ scanned: number, stamped: number, skipped: number, durationMs: number }>}
   */
  async runJob() {
    const cutoffDate = new Date(Date.now() - ABANDON_THRESHOLD_DAYS * 24 * 60 * 60 * 1000);
    const dateKey    = new Date().toISOString().split('T')[0]; // YYYY-MM-DD UTC

    const idempotencyKey = BaseWorker.buildIdempotencyKey('system', {
      job:  'abandoned-onboarding',
      date: dateKey,
    });

    const { result } = await this.run({ cutoffDate }, idempotencyKey);
    return result;
  }
}

module.exports = new AbandonedOnboardingWorker();








