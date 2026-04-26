'use strict';

const metricsService = require('../ai/observability/metrics.service');
// FIX: was using console.* — replaced with structured logger for proper log routing
const logger = require('../utils/logger');

/**
 * DailyAggregationWorker
 *
 * Runs nightly to aggregate raw ai_logs → ai_metrics_daily.
 * Schedule: 1am UTC daily via Cloud Scheduler, cron, or node-cron.
 *
 * Deployment options:
 *  A) Cloud Scheduler → Cloud Run Job (recommended for production)
 *  B) node-cron in main process (simpler, works for single-instance deployments)
 *  C) Cloud Functions scheduled function
 *
 * This file is the job handler — call runJob() from your scheduler entry point.
 */
class DailyAggregationWorker {
  /**
   * Run aggregation for a specific date (defaults to yesterday UTC).
   * Idempotent — safe to re-run for same date.
   *
   * @param {string} [dateStr] - 'YYYY-MM-DD', defaults to yesterday
   */
  async runJob(dateStr = null) {
    const targetDate = dateStr || this._yesterdayUTC();
    const jobStart = Date.now();

    logger.info('[AggregationWorker] Starting daily aggregation', { targetDate });

    try {
      const results = await metricsService.runDailyAggregation(targetDate);
      const elapsed = Date.now() - jobStart;

      const summary = {
        date: targetDate,
        durationMs: elapsed,
        features: results,
        errors: results.filter(r => r.status === 'error').length,
        success: results.filter(r => r.status === 'ok').length,
      };

      logger.info('[AggregationWorker] Completed', summary);
      return summary;
    } catch (err) {
      logger.error('[AggregationWorker] Job failed', { error: err.message, stack: err.stack });
      throw err;
    }
  }

  _yesterdayUTC() {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().split('T')[0];
  }
}

// Entry point when invoked directly (e.g., via Cloud Run Job)
// MIGRATION: firebase-admin initializeApp() removed — this worker delegates
// entirely to metricsService.runDailyAggregation() which uses Supabase
// internally. No Firebase initialisation is needed.
if (require.main === module) {
  const worker  = new DailyAggregationWorker();
  const dateArg = process.argv[2] || null; // optional: pass YYYY-MM-DD as CLI arg

  worker.runJob(dateArg)
    .then(result => {
      logger.info('[AggregationWorker] CLI completed', { result });
      process.exit(0);
    })
    .catch(err => {
      logger.error('[AggregationWorker] CLI failed', { error: err.message, stack: err.stack });
      process.exit(1);
    });
}

module.exports = new DailyAggregationWorker();