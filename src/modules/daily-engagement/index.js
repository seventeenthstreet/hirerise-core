'use strict';

/**
 * modules/daily-engagement/index.js
 *
 * Barrel export for the Daily Engagement System.
 *
 * Three modules in one:
 *   1. Daily Career Insights Feed      — /api/career/daily-insights
 *   2. Career Progress Tracker         — /api/career/progress
 *   3. Career Opportunity Alerts       — /api/career/alerts
 *
 * ─── Server registration (server.js) ─────────────────────────────────────────
 *
 *   const { engagementRouter } = require('./modules/daily-engagement');
 *
 *   // Mount under the existing /api/v1/career prefix
 *   // Option A: standalone mount (if career.routes.js doesn't exist yet)
 *   app.use(`${API_PREFIX}/career`, authenticate, engagementRouter);
 *
 *   // Option B: inside career.routes.js (add at the bottom before module.exports)
 *   const { engagementRouter } = require('../modules/daily-engagement');
 *   router.use('/', engagementRouter);
 *
 * ─── BullMQ worker (separate process or main process) ────────────────────────
 *
 *   // Start inline (main process):
 *   const { startEngagementWorker } = require('./modules/daily-engagement');
 *   startEngagementWorker();
 *
 *   // Or run standalone:
 *   node src/modules/daily-engagement/workers/engagement.worker.js
 *
 * ─── Trigger events from existing engines ────────────────────────────────────
 *
 *   const { engagementQueue } = require('./modules/daily-engagement');
 *
 *   // After CV is parsed:
 *   await engagementQueue.onCvParsed(userId, { role, skills, chi_score });
 *
 *   // After job match:
 *   await engagementQueue.onNewJobMatch(userId, { job_title, company, match_score, job_id });
 *
 *   // After skill gap update:
 *   await engagementQueue.onSkillGapUpdated(userId, { current_skills_count, trending_missing_skills });
 *
 *   // After market trend refresh:
 *   await engagementQueue.onMarketTrendUpdated(userId, { top_surging_skill, surge_rate, salary_change });
 *
 *   // After opportunity detected:
 *   await engagementQueue.onOpportunityDetected(userId, { opportunity_title, match_score });
 */

const engagementRouter  = require('./routes/engagement.routes');
const engagementQueue   = require('./events/engagementQueue');
const insightsService   = require('./services/insights.service');
const progressService   = require('./services/progress.service');
const alertsService     = require('./services/alerts.service');
const { start: startEngagementWorker, stop: stopEngagementWorker } = require('./workers/engagement.worker');

module.exports = {
  engagementRouter,
  engagementQueue,
  insightsService,
  progressService,
  alertsService,
  startEngagementWorker,
  stopEngagementWorker,
};









