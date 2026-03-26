'use strict';

/**
 * modules/daily-engagement/workers/engagement.worker.js
 *
 * BullMQ Worker — Daily Engagement Event Handler
 *
 * Listens to the 'daily-engagement' queue and processes five event types:
 *
 *   CV_PARSED              → record progress + generate insights + risk alert if applicable
 *   SKILL_GAP_UPDATED      → record progress + generate insights + skill demand alerts
 *   NEW_JOB_MATCH          → record progress + job match alert + job match insight
 *   MARKET_TREND_UPDATED   → generate insights + skill demand / salary alerts
 *   OPPORTUNITY_DETECTED   → generate insights + opportunity alert
 *
 * Each job in the queue has the shape:
 *   { name: ENGAGEMENT_EVENTS.X, data: { userId, payload: {...} } }
 *
 * Startup:
 *   node src/modules/daily-engagement/workers/engagement.worker.js
 *   — or import and call start() from your main process.
 *
 * The queue is also used internally by engagementQueue.js (the publisher)
 * which is called from existing engine hooks.
 *
 * Graceful shutdown:
 *   The worker listens for SIGTERM/SIGINT and drains before exiting.
 */

'use strict';

require('dotenv').config();

const logger = require('../../../utils/logger');

const insightsService = require('../services/insights.service');
const progressService = require('../services/progress.service');
const alertsService   = require('../services/alerts.service');

const {
  ENGAGEMENT_EVENTS,
  QUEUE_NAME,
  PROGRESS_TRIGGERS,
} = require('../models/engagement.constants');

// ─── BullMQ setup ─────────────────────────────────────────────────────────────

let _worker = null;

function _getRedisConnection() {
  const host     = process.env.REDIS_HOST     || '127.0.0.1';
  const port     = parseInt(process.env.REDIS_PORT || '6379', 10);
  const password = process.env.REDIS_PASSWORD || undefined;
  const tls      = process.env.REDIS_TLS === 'true' ? {} : undefined;
  return { host, port, password, tls };
}

// ─── Job handlers ─────────────────────────────────────────────────────────────

/**
 * Handle CV_PARSED event.
 *
 * A resume was uploaded and parsed. This is the broadest trigger:
 *   - Record a progress snapshot with the latest scores
 *   - Generate fresh insights across all engines
 *   - If risk score is high, fire a risk warning alert
 */
async function handleCvParsed(job) {
  const { userId, payload = {} } = job.data;
  logger.info('[EngagementWorker] CV_PARSED', { userId, jobId: job.id });

  await Promise.allSettled([
    progressService.recordProgress({
      userId,
      triggerEvent: PROGRESS_TRIGGERS.CV_PARSED,
      overrides: {
        chi:              payload.chi_score       || null,
        skills_count:     payload.skills_count    || null,
        job_match_score:  payload.job_match_score || null,
      },
    }),
    insightsService.generateInsightsForUser(userId, {
      role:     payload.role,
      skills:   payload.skills,
      industry: payload.industry,
    }),
  ]);

  // Risk warning if score was included in event payload
  if (payload.risk_score && payload.risk_score >= 60) {
    await alertsService.createRiskWarningAlert({
      userId,
      riskScore:  payload.risk_score,
      topFactor:  payload.top_risk_factor || null,
    }).catch(err => logger.warn('[EngagementWorker] Risk alert creation failed', { err: err.message }));
  }
}

/**
 * Handle SKILL_GAP_UPDATED event.
 *
 * The Skill Graph Engine has updated the user's skill gap analysis.
 *   - Record a progress snapshot
 *   - Generate fresh insights
 *   - Create skill demand alerts for trending missing skills
 */
async function handleSkillGapUpdated(job) {
  const { userId, payload = {} } = job.data;
  logger.info('[EngagementWorker] SKILL_GAP_UPDATED', { userId, jobId: job.id });

  await Promise.allSettled([
    progressService.recordProgress({
      userId,
      triggerEvent: PROGRESS_TRIGGERS.SKILL_GAP_UPDATED,
      overrides: {
        skills_count: payload.current_skills_count || null,
      },
    }),
    insightsService.generateInsightsForUser(userId),
  ]);

  // Fire skill demand alerts for top missing skills that are trending
  const trendingMissing = (payload.trending_missing_skills || []).slice(0, 2);
  for (const skill of trendingMissing) {
    await alertsService.createSkillDemandAlert({
      userId,
      skill:      skill.name || skill,
      growthRate: skill.growth_rate || 15,
    }).catch(() => { /* non-fatal */ });
  }
}

/**
 * Handle NEW_JOB_MATCH event.
 *
 * The Job Matching Engine found a new match above the threshold.
 *   - Record a progress snapshot (with the new job match score)
 *   - Create a job match alert
 *   - Generate insights (will include this job match)
 */
async function handleNewJobMatch(job) {
  const { userId, payload = {} } = job.data;
  logger.info('[EngagementWorker] NEW_JOB_MATCH', { userId, jobId: job.id });

  const matchScore = payload.match_score || payload.score || 0;

  await Promise.allSettled([
    progressService.recordProgress({
      userId,
      triggerEvent: PROGRESS_TRIGGERS.NEW_JOB_MATCH,
      overrides: { job_match_score: matchScore },
    }),
    alertsService.createJobMatchAlert({
      userId,
      jobTitle:   payload.job_title   || payload.title || 'New Role',
      company:    payload.company     || null,
      matchScore: matchScore,
      jobId:      payload.job_id      || null,
    }),
    insightsService.generateInsightsForUser(userId),
  ]);
}

/**
 * Handle MARKET_TREND_UPDATED event.
 *
 * The Labor Market Intelligence Engine has refreshed its data.
 * This is a global event (not user-specific) but we can still generate
 * personalised insights because the LMI data feeds into the insight builders.
 *
 * Note: payload.affected_users[] lets callers target specific users.
 *       If absent, this job is skipped (avoid fan-out to all users).
 */
async function handleMarketTrendUpdated(job) {
  const { userId, payload = {} } = job.data;

  if (!userId) {
    logger.warn('[EngagementWorker] MARKET_TREND_UPDATED without userId — skipping', { jobId: job.id });
    return;
  }

  logger.info('[EngagementWorker] MARKET_TREND_UPDATED', { userId, jobId: job.id });

  await insightsService.generateInsightsForUser(userId);

  // Salary trend alert if data is present
  if (payload.salary_change && Math.abs(payload.salary_change) >= 5) {
    await alertsService.createSalaryTrendAlert({
      userId,
      role:         payload.role || 'Your target role',
      salaryChange: payload.salary_change,
      direction:    payload.salary_change > 0 ? 'up' : 'down',
    }).catch(() => { /* non-fatal */ });
  }

  // Skill demand alert for surging skills
  const surgingSkill = payload.top_surging_skill;
  if (surgingSkill && (payload.surge_rate || 0) >= 10) {
    await alertsService.createSkillDemandAlert({
      userId,
      skill:      surgingSkill,
      growthRate: payload.surge_rate,
    }).catch(() => { /* non-fatal */ });
  }
}

/**
 * Handle OPPORTUNITY_DETECTED event.
 *
 * The AI Career Opportunity Radar found a new opportunity for the user.
 *   - Generate insights
 *   - Create an opportunity alert
 */
async function handleOpportunityDetected(job) {
  const { userId, payload = {} } = job.data;
  logger.info('[EngagementWorker] OPPORTUNITY_DETECTED', { userId, jobId: job.id });

  await Promise.allSettled([
    insightsService.generateInsightsForUser(userId),
    alertsService.createOpportunityAlert({
      userId,
      opportunityTitle: payload.opportunity_title || payload.role || 'New Opportunity',
      matchScore:       payload.match_score || payload.score || 70,
      opportunityId:    payload.opportunity_id || null,
    }),
  ]);
}

// ─── Handler dispatch ─────────────────────────────────────────────────────────

const HANDLERS = {
  [ENGAGEMENT_EVENTS.CV_PARSED]:             handleCvParsed,
  [ENGAGEMENT_EVENTS.SKILL_GAP_UPDATED]:     handleSkillGapUpdated,
  [ENGAGEMENT_EVENTS.NEW_JOB_MATCH]:         handleNewJobMatch,
  [ENGAGEMENT_EVENTS.MARKET_TREND_UPDATED]:  handleMarketTrendUpdated,
  [ENGAGEMENT_EVENTS.OPPORTUNITY_DETECTED]:  handleOpportunityDetected,
};

async function processJob(job) {
  const eventName = job.name;
  const handler   = HANDLERS[eventName];

  if (!handler) {
    logger.warn('[EngagementWorker] Unknown event type', { eventName, jobId: job.id });
    return;
  }

  if (!job.data?.userId) {
    logger.warn('[EngagementWorker] Job missing userId', { eventName, jobId: job.id });
    return;
  }

  await handler(job);
}

// ─── Worker lifecycle ─────────────────────────────────────────────────────────

/**
 * start()
 *
 * Initialise and start the BullMQ worker.
 * Safe to call multiple times — idempotent.
 *
 * @returns {Object}  The BullMQ Worker instance
 */
function start() {
  if (_worker) return _worker;

  let Worker;
  try {
    ({ Worker } = require('bullmq'));
  } catch {
    logger.error('[EngagementWorker] bullmq not installed. Run: npm install bullmq');
    process.exit(1);
  }

  const connection = _getRedisConnection();

  _worker = new Worker(QUEUE_NAME, processJob, {
    connection,
    concurrency:    parseInt(process.env.ENGAGEMENT_WORKER_CONCURRENCY || '5', 10),
    removeOnComplete: { count: 500 },
    removeOnFail:     { count: 200 },
  });

  _worker.on('completed', (job) => {
    logger.info('[EngagementWorker] Job completed', { jobId: job.id, name: job.name });
  });

  _worker.on('failed', (job, err) => {
    logger.error('[EngagementWorker] Job failed', {
      jobId: job?.id,
      name:  job?.name,
      err:   err.message,
    });
  });

  _worker.on('error', (err) => {
    logger.error('[EngagementWorker] Worker error', { err: err.message });
  });

  logger.info('[EngagementWorker] Worker started', { queue: QUEUE_NAME });
  return _worker;
}

/**
 * stop()
 * Gracefully drain and close the worker.
 */
async function stop() {
  if (_worker) {
    await _worker.close();
    _worker = null;
    logger.info('[EngagementWorker] Worker stopped');
  }
}

// ─── Entry point (standalone process) ────────────────────────────────────────

if (require.main === module) {
  const worker = start();

  async function shutdown(signal) {
    logger.info(`[EngagementWorker] ${signal} received — shutting down…`);
    await stop();
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

module.exports = { start, stop, processJob };









