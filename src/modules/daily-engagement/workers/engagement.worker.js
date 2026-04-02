'use strict';

/**
 * modules/daily-engagement/workers/engagement.worker.js
 *
 * Production-grade BullMQ Worker — Daily Engagement Event Handler
 *
 * Improvements:
 * - removed signature drift
 * - structured allSettled failure logging
 * - parallelized alert fanout
 * - safer concurrency parsing
 * - cleaner lifecycle
 */

require('dotenv').config();

const logger = require('../../../utils/logger');

const insightsService = require('../services/insights.service');
const progressService = require('../services/progress.service');
const alertsService = require('../services/alerts.service');

const {
  ENGAGEMENT_EVENTS,
  QUEUE_NAME,
  PROGRESS_TRIGGERS,
} = require('../models/engagement.constants');

let _worker = null;

function parseConcurrency(value, fallback = 5) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(parsed, 20));
}

function getRedisConnection() {
  return {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number.parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
  };
}

async function settleAndLog(tasks, context) {
  const results = await Promise.allSettled(tasks);

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      logger.warn('[EngagementWorker] Task failed (non-fatal)', {
        ...context,
        taskIndex: index,
        error: result.reason?.message || String(result.reason),
      });
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

async function handleCvParsed(job) {
  const { userId, payload = {} } = job.data;

  logger.info('[EngagementWorker] CV_PARSED', {
    userId,
    jobId: job.id,
  });

  await settleAndLog(
    [
      progressService.recordProgress({
        userId,
        triggerEvent: PROGRESS_TRIGGERS.CV_PARSED,
        overrides: {
          chi: payload.chi_score ?? null,
          skills_count: payload.skills_count ?? null,
          job_match_score: payload.job_match_score ?? null,
        },
      }),
      insightsService.generateInsightsForUser(userId),
    ],
    { event: ENGAGEMENT_EVENTS.CV_PARSED, userId, jobId: job.id }
  );

  if ((payload.risk_score ?? 0) >= 60) {
    await alertsService.createRiskWarningAlert({
      userId,
      riskScore: payload.risk_score,
      topFactor: payload.top_risk_factor ?? null,
    }).catch((err) =>
      logger.warn('[EngagementWorker] Risk alert failed', {
        userId,
        jobId: job.id,
        error: err.message,
      })
    );
  }
}

async function handleSkillGapUpdated(job) {
  const { userId, payload = {} } = job.data;

  logger.info('[EngagementWorker] SKILL_GAP_UPDATED', {
    userId,
    jobId: job.id,
  });

  await settleAndLog(
    [
      progressService.recordProgress({
        userId,
        triggerEvent: PROGRESS_TRIGGERS.SKILL_GAP_UPDATED,
        overrides: {
          skills_count: payload.current_skills_count ?? null,
        },
      }),
      insightsService.generateInsightsForUser(userId),
    ],
    { event: ENGAGEMENT_EVENTS.SKILL_GAP_UPDATED, userId, jobId: job.id }
  );

  const trendingMissing = (payload.trending_missing_skills ?? []).slice(0, 2);

  await Promise.allSettled(
    trendingMissing.map((skill) =>
      alertsService.createSkillDemandAlert({
        userId,
        skill: skill.name || skill,
        growthRate: skill.growth_rate ?? 15,
      })
    )
  );
}

async function handleNewJobMatch(job) {
  const { userId, payload = {} } = job.data;
  const matchScore = payload.match_score ?? payload.score ?? 0;

  logger.info('[EngagementWorker] NEW_JOB_MATCH', {
    userId,
    jobId: job.id,
  });

  await settleAndLog(
    [
      progressService.recordProgress({
        userId,
        triggerEvent: PROGRESS_TRIGGERS.NEW_JOB_MATCH,
        overrides: {
          job_match_score: matchScore,
        },
      }),
      alertsService.createJobMatchAlert({
        userId,
        jobTitle: payload.job_title ?? payload.title ?? 'New Role',
        company: payload.company ?? null,
        matchScore,
        jobId: payload.job_id ?? null,
      }),
      insightsService.generateInsightsForUser(userId),
    ],
    { event: ENGAGEMENT_EVENTS.NEW_JOB_MATCH, userId, jobId: job.id }
  );
}

async function handleMarketTrendUpdated(job) {
  const { userId, payload = {} } = job.data;

  logger.info('[EngagementWorker] MARKET_TREND_UPDATED', {
    userId,
    jobId: job.id,
  });

  await settleAndLog(
    [insightsService.generateInsightsForUser(userId)],
    { event: ENGAGEMENT_EVENTS.MARKET_TREND_UPDATED, userId, jobId: job.id }
  );

  const alertTasks = [];

  if (Math.abs(payload.salary_change ?? 0) >= 5) {
    alertTasks.push(
      alertsService.createSalaryTrendAlert({
        userId,
        role: payload.role ?? 'Your target role',
        salaryChange: payload.salary_change,
        direction: payload.salary_change > 0 ? 'up' : 'down',
      })
    );
  }

  if (payload.top_surging_skill && (payload.surge_rate ?? 0) >= 10) {
    alertTasks.push(
      alertsService.createSkillDemandAlert({
        userId,
        skill: payload.top_surging_skill,
        growthRate: payload.surge_rate,
      })
    );
  }

  if (alertTasks.length) {
    await settleAndLog(alertTasks, {
      event: ENGAGEMENT_EVENTS.MARKET_TREND_UPDATED,
      userId,
      jobId: job.id,
    });
  }
}

async function handleOpportunityDetected(job) {
  const { userId, payload = {} } = job.data;

  logger.info('[EngagementWorker] OPPORTUNITY_DETECTED', {
    userId,
    jobId: job.id,
  });

  await settleAndLog(
    [
      insightsService.generateInsightsForUser(userId),
      alertsService.createOpportunityAlert({
        userId,
        opportunityTitle:
          payload.opportunity_title ?? payload.role ?? 'New Opportunity',
        matchScore: payload.match_score ?? payload.score ?? 70,
        opportunityId: payload.opportunity_id ?? null,
      }),
    ],
    { event: ENGAGEMENT_EVENTS.OPPORTUNITY_DETECTED, userId, jobId: job.id }
  );
}

const HANDLERS = {
  [ENGAGEMENT_EVENTS.CV_PARSED]: handleCvParsed,
  [ENGAGEMENT_EVENTS.SKILL_GAP_UPDATED]: handleSkillGapUpdated,
  [ENGAGEMENT_EVENTS.NEW_JOB_MATCH]: handleNewJobMatch,
  [ENGAGEMENT_EVENTS.MARKET_TREND_UPDATED]: handleMarketTrendUpdated,
  [ENGAGEMENT_EVENTS.OPPORTUNITY_DETECTED]: handleOpportunityDetected,
};

async function processJob(job) {
  const handler = HANDLERS[job.name];

  if (!handler) {
    logger.warn('[EngagementWorker] Unknown event type', {
      eventName: job.name,
      jobId: job.id,
    });
    return;
  }

  if (!job.data?.userId) {
    logger.warn('[EngagementWorker] Job missing userId', {
      eventName: job.name,
      jobId: job.id,
    });
    return;
  }

  await handler(job);
}

function start() {
  if (_worker) return _worker;

  let Worker;
  try {
    ({ Worker } = require('bullmq'));
  } catch {
    logger.error('[EngagementWorker] bullmq not installed');
    process.exit(1);
  }

  _worker = new Worker(QUEUE_NAME, processJob, {
    connection: getRedisConnection(),
    concurrency: parseConcurrency(
      process.env.ENGAGEMENT_WORKER_CONCURRENCY
    ),
  });

  _worker.on('completed', (job) => {
    logger.info('[EngagementWorker] Job completed', {
      jobId: job.id,
      name: job.name,
    });
  });

  _worker.on('failed', (job, err) => {
    logger.error('[EngagementWorker] Job failed', {
      jobId: job?.id,
      name: job?.name,
      error: err.message,
    });
  });

  _worker.on('error', (err) => {
    logger.error('[EngagementWorker] Worker error', {
      error: err.message,
    });
  });

  logger.info('[EngagementWorker] Worker started', {
    queue: QUEUE_NAME,
  });

  return _worker;
}

async function stop() {
  if (!_worker) return;
  await _worker.close();
  _worker = null;
  logger.info('[EngagementWorker] Worker stopped');
}

if (require.main === module) {
  start();

  async function shutdown(signal) {
    logger.info(`[EngagementWorker] ${signal} received`);
    await stop();
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = {
  start,
  stop,
  processJob,
};