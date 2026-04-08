'use strict';

/**
 * sla-evaluation.worker.js
 *
 * Fully Supabase-ready SLA evaluation worker.
 * No Firebase dependencies remain.
 */

const slaService = require('../ai/observability/sla.service');
const BaseWorker = require('./shared/BaseWorker');
const logger = require('../utils/logger');

const WORKER_ID = 'sla-evaluation';

class SLAEvaluationWorker extends BaseWorker {
  constructor() {
    super(WORKER_ID);
  }

  /**
   * Core SLA evaluation logic
   *
   * @param {{ targetDate: string }} payload
   * @returns {Promise<{ date: string, breaches: Array }>}
   */
  async process({ targetDate }) {
    const startedAt = Date.now();

    logger.info('[SLAEvaluationWorker] Starting evaluation', {
      targetDate
    });

    try {
      const breaches = await slaService.evaluateDailySLA(targetDate);

      const durationMs = Date.now() - startedAt;

      logger.info('[SLAEvaluationWorker] Evaluation complete', {
        targetDate,
        breachCount: Array.isArray(breaches) ? breaches.length : 0,
        durationMs
      });

      return {
        date: targetDate,
        breaches: Array.isArray(breaches) ? breaches : []
      };
    } catch (error) {
      logger.error('[SLAEvaluationWorker] Evaluation failed', {
        targetDate,
        error: error?.message
      });
      throw error;
    }
  }

  /**
   * Backward-compatible wrapper
   *
   * @param {string|null} dateStr
   */
  async runJob(dateStr = null) {
    const targetDate = dateStr ?? this._yesterdayUTC();

    const idempotencyKey = BaseWorker.buildIdempotencyKey('system', {
      job: WORKER_ID,
      date: targetDate
    });

    const { result } = await this.run({ targetDate }, idempotencyKey);
    return result;
  }

  _yesterdayUTC() {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - 1);
    return date.toISOString().slice(0, 10);
  }
}

const slaWorker = new SLAEvaluationWorker();

if (require.main === module) {
  const dateArg = process.argv[2] ?? null;

  slaWorker
    .runJob(dateArg)
    .then(result => {
      logger.info('[SLAEvaluationWorker] CLI success', result);
      process.exit(0);
    })
    .catch(error => {
      logger.error('[SLAEvaluationWorker] CLI failed', {
        error: error?.message,
        stack: error?.stack
      });
      process.exit(1);
    });
}

module.exports = slaWorker;