'use strict';

/**
 * sla-evaluation.worker.js — PHASE 1 UPDATE: Extends BaseWorker
 *
 * CHANGE: Class now extends BaseWorker. Core evaluation logic moved from
 * runJob() into process(). runJob() kept as a thin backward-compatible wrapper.
 *
 * IDEMPOTENCY KEY STRATEGY:
 *   hash("sla:" + YYYY-MM-DD)
 *   — One key per target date. Re-running for the same date returns the
 *   cached breach list without re-evaluating SLA contracts. Expires after 48h.
 *
 * Run after daily aggregation completes.
 * Evaluates SLA contracts against freshly aggregated metrics.
 */

const slaService = require('../ai/observability/sla.service');
const BaseWorker = require('./shared/BaseWorker');

class SLAEvaluationWorker extends BaseWorker {
  constructor() {
    super('sla-evaluation');
  }

  /**
   * Core evaluation logic — called by BaseWorker.run() after idempotency check.
   *
   * @param {{ targetDate: string }} payload
   * @returns {Promise<{ date: string, breaches: Array }>}
   */
  async process({ targetDate }) {
    console.log(`[SLAWorker] Evaluating SLA for ${targetDate}`);
    const breaches = await slaService.evaluateDailySLA(targetDate);
    console.log(`[SLAWorker] Found ${breaches.length} SLA breaches`);
    return { date: targetDate, breaches };
  }

  /**
   * Backward-compatible wrapper. Existing call sites use runJob(dateStr) unchanged.
   *
   * @param {string=} dateStr  — YYYY-MM-DD, defaults to yesterday UTC
   */
  async runJob(dateStr = null) {
    const targetDate = dateStr || this._yesterdayUTC();

    const idempotencyKey = BaseWorker.buildIdempotencyKey('system', {
      job:  'sla-evaluation',
      date: targetDate,
    });

    const { result } = await this.run({ targetDate }, idempotencyKey);
    return result;
  }

  _yesterdayUTC() {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().split('T')[0];
  }
}

const slaWorker = new SLAEvaluationWorker();

// MIGRATION: firebase-admin initializeApp() removed — slaService uses Supabase
// internally. No Firebase initialisation is needed before running the job.
if (require.main === module) {
  slaWorker.runJob(process.argv[2] || null)
    .then(r => { console.log('SLA job done:', r); process.exit(0); })
    .catch(e => { console.error(e); process.exit(1); });
}

module.exports = slaWorker;








