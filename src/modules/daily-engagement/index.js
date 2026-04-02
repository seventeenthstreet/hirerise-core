'use strict';

/**
 * modules/daily-engagement/index.js
 *
 * Production-grade barrel export for Daily Engagement.
 *
 * Improvements:
 * - lazy worker loading
 * - circular dependency safer exports
 * - reduced cold-start cost
 * - cleaner public module contract
 */

// ─────────────────────────────────────────────────────────────────────────────
// Core exports (safe eager loads)
// ─────────────────────────────────────────────────────────────────────────────

const engagementRouter = require('./routes/engagement.routes');
const engagementQueue = require('./events/engagementQueue');
const insightsService = require('./services/insights.service');
const progressService = require('./services/progress.service');
const alertsService = require('./services/alerts.service');

// ─────────────────────────────────────────────────────────────────────────────
// Lazy worker lifecycle
// ─────────────────────────────────────────────────────────────────────────────

function startEngagementWorker() {
  const worker = require('./workers/engagement.worker');
  return worker.start();
}

function stopEngagementWorker() {
  const worker = require('./workers/engagement.worker');
  return worker.stop();
}

module.exports = Object.freeze({
  engagementRouter,
  engagementQueue,
  insightsService,
  progressService,
  alertsService,
  startEngagementWorker,
  stopEngagementWorker,
});