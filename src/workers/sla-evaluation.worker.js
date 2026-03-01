'use strict';

const slaService = require('../ai/observability/sla.service');

/**
 * sla-evaluation.worker.js
 * Run after daily aggregation completes.
 * Evaluates SLA contracts against freshly aggregated metrics.
 */
class SLAEvaluationWorker {
  async runJob(dateStr = null) {
    const targetDate = dateStr || this._yesterdayUTC();
    console.log(`[SLAWorker] Evaluating SLA for ${targetDate}`);
    const breaches = await slaService.evaluateDailySLA(targetDate);
    console.log(`[SLAWorker] Found ${breaches.length} SLA breaches`);
    return { date: targetDate, breaches };
  }

  _yesterdayUTC() {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().split('T')[0];
  }
}

if (require.main === module) {
  const admin = require('firebase-admin');
  if (!admin.apps.length) admin.initializeApp();
  const worker = new SLAEvaluationWorker();
  worker.runJob(process.argv[2] || null)
    .then(r => { console.log('SLA job done:', r); process.exit(0); })
    .catch(e => { console.error(e); process.exit(1); });
}

module.exports = new SLAEvaluationWorker();