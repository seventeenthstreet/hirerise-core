'use strict';

/**
 * abandonedOnboarding.worker.js
 *
 * Patch 44 production-safe:
 * - authoritative onboarding abandonment stamping
 * - split-brain safe completion checks
 * - chunked replay-safe mutation flow
 * - deterministic idempotency support
 */

const { supabase } = require('../config/supabase');
const logger = require('../utils/logger');
const BaseWorker = require('./shared/BaseWorker');
const {
  authoritativeUpsert,
} = require('../lib/db/authoritativeMutation');

const ABANDON_THRESHOLD_DAYS = parseInt(
  process.env.ONBOARDING_ABANDON_DAYS || '7',
  10
);

const BATCH_SIZE = 400;

const TABLES = Object.freeze({
  ONBOARDING_PROGRESS: 'onboarding_progress',
});

class AbandonedOnboardingWorker extends BaseWorker {
  constructor() {
    super('abandoned-onboarding');
  }

  /**
   * Core job logic
   *
   * @param {{ cutoffDate: Date }} payload
   * @returns {Promise<{ scanned: number, stamped: number, skipped: number, durationMs: number }>}
   */
  async process({ cutoffDate }) {
    const jobStart = Date.now();
    const cutoffISO = cutoffDate.toISOString();

    logger.info(
      '[AbandonedOnboardingWorker] Starting job',
      {
        thresholdDays: ABANDON_THRESHOLD_DAYS,
        cutoff: cutoffISO,
      }
    );

    const { data: rows, error } = await supabase
      .from(TABLES.ONBOARDING_PROGRESS)
      .select('*')
      .lt('last_active_at', cutoffISO);

    if (error) {
      throw new Error(
        `[AbandonedOnboardingWorker] Query failed: ${error.message}`
      );
    }

    const docs = (rows ?? []).filter(
      (row) =>
        !row.onboarding_completed &&
        !row.abandoned_at
    );

    if (docs.length === 0) {
      const durationMs = Date.now() - jobStart;

      logger.info(
        '[AbandonedOnboardingWorker] No inactive docs found',
        { cutoff: cutoffISO }
      );

      return {
        scanned: 0,
        stamped: 0,
        skipped: 0,
        durationMs,
      };
    }

    const scanned = docs.length;
    let stamped = 0;
    let skipped = 0;
    const nowISO = new Date().toISOString();

    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
      const chunk = docs.slice(i, i + BATCH_SIZE);

      for (const row of chunk) {
        if (
          row.abandoned_at ||
          row.onboarding_completed
        ) {
          skipped++;
          continue;
        }

        await authoritativeUpsert({
          table: TABLES.ONBOARDING_PROGRESS,
          payload: {
            id: row.id,
            abandoned_at: nowISO,
            abandoned_at_step:
              row.last_active_step || 'unknown',
            updated_at: nowISO,
          },
          conflictKey: 'id',
        });

        stamped++;
      }

      logger.debug(
        '[AbandonedOnboardingWorker] Batch committed',
        {
          batchIndex: Math.floor(i / BATCH_SIZE),
          batchSize: chunk.length,
          stamped,
        }
      );
    }

    const durationMs = Date.now() - jobStart;

    logger.info(
      '[AbandonedOnboardingWorker] Job complete',
      {
        scanned,
        stamped,
        skipped,
        durationMs,
      }
    );

    return {
      scanned,
      stamped,
      skipped,
      durationMs,
    };
  }

  /**
   * Backward-compatible wrapper
   */
  async runJob() {
    const cutoffDate = new Date(
      Date.now() -
        ABANDON_THRESHOLD_DAYS *
          24 *
          60 *
          60 *
          1000
    );

    const dateKey = new Date()
      .toISOString()
      .slice(0, 10);

    const idempotencyKey =
      BaseWorker.buildIdempotencyKey('system', {
        job: 'abandoned-onboarding',
        date: dateKey,
      });

    const { result } = await this.run(
      { cutoffDate },
      idempotencyKey
    );

    return result;
  }
}

module.exports = new AbandonedOnboardingWorker();