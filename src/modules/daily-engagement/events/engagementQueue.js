'use strict';

/**
 * modules/daily-engagement/events/engagementQueue.js
 *
 * BullMQ Queue Publisher — Daily Engagement Event Bus
 *
 * Provides typed helper functions for every engine in the platform to
 * enqueue engagement events WITHOUT modifying those engines.
 *
 * The pattern:
 *   Existing engine finishes its work → calls engagementQueue.onCvParsed(userId, data)
 *   → enqueues a BullMQ job to the 'daily-engagement' queue
 *   → engagement.worker.js picks it up asynchronously
 *
 * All functions are fire-and-forget from the caller's perspective.
 * They await internally but errors are caught and logged — a queue
 * enqueue failure should never block the primary engine response.
 *
 * Usage from existing engines (examples):
 *
 *   // In resume parsing handler:
 *   const engagementQueue = require('../modules/daily-engagement/events/engagementQueue');
 *   await engagementQueue.onCvParsed(userId, { role, skills, chi_score });
 *
 *   // In job match engine:
 *   await engagementQueue.onNewJobMatch(userId, { job_title, company, match_score, job_id });
 *
 *   // In LMI worker:
 *   await engagementQueue.onMarketTrendUpdated(userId, { top_surging_skill, surge_rate });
 */

'use strict';

const logger = require('../../../utils/logger');
const { ENGAGEMENT_EVENTS, QUEUE_NAME } = require('../models/engagement.constants');

// ─── Queue singleton ──────────────────────────────────────────────────────────

let _queue = null;

function _getRedisConnection() {
  const host     = process.env.REDIS_HOST     || '127.0.0.1';
  const port     = parseInt(process.env.REDIS_PORT || '6379', 10);
  const password = process.env.REDIS_PASSWORD || undefined;
  const tls      = process.env.REDIS_TLS === 'true' ? {} : undefined;
  return { host, port, password, tls };
}

function getQueue() {
  if (_queue) return _queue;

  let Queue;
  try {
    ({ Queue } = require('bullmq'));
  } catch {
    logger.warn('[EngagementQueue] bullmq not installed — queue disabled. Run: npm install bullmq');
    return null;
  }

  _queue = new Queue(QUEUE_NAME, {
    connection: _getRedisConnection(),
    defaultJobOptions: {
      attempts:   3,
      backoff:    { type: 'exponential', delay: 2000 },
      removeOnComplete: { count: 500 },
      removeOnFail:     { count: 200 },
    },
  });

  _queue.on('error', (err) => {
    logger.error('[EngagementQueue] Queue error', { err: err.message });
  });

  logger.info('[EngagementQueue] Queue initialised', { queue: QUEUE_NAME });
  return _queue;
}

// ─── Core enqueue helper ──────────────────────────────────────────────────────

/**
 * enqueue(eventName, userId, payload)
 *
 * Internal helper. All public functions call this.
 * Swallows errors — engagement queue failures must never block callers.
 *
 * @param {string} eventName  — one of ENGAGEMENT_EVENTS
 * @param {string} userId
 * @param {Object} payload
 * @returns {Promise<void>}
 */
async function enqueue(eventName, userId, payload = {}) {
  const queue = getQueue();
  if (!queue) return;

  try {
    const job = await queue.add(eventName, { userId, payload }, {
      jobId: `${eventName}:${userId}:${Date.now()}`,
    });
    logger.debug('[EngagementQueue] Enqueued', { eventName, userId, jobId: job.id });
  } catch (err) {
    logger.warn('[EngagementQueue] Enqueue failed (non-fatal)', {
      eventName,
      userId,
      err: err.message,
    });
  }
}

// ─── Typed event publishers ───────────────────────────────────────────────────

/**
 * onCvParsed(userId, data)
 *
 * Call this after a CV has been successfully parsed by the Resume Intelligence Engine.
 *
 * @param {string} userId
 * @param {Object} data  — { role?, skills?, industry?, chi_score?, risk_score?, skills_count?, job_match_score? }
 */
async function onCvParsed(userId, data = {}) {
  await enqueue(ENGAGEMENT_EVENTS.CV_PARSED, userId, data);
}

/**
 * onSkillGapUpdated(userId, data)
 *
 * Call this after the Skill Graph / Skill Gap Engine updates the user's analysis.
 *
 * @param {string} userId
 * @param {Object} data  — { current_skills_count?, trending_missing_skills?: [{name, growth_rate}] }
 */
async function onSkillGapUpdated(userId, data = {}) {
  await enqueue(ENGAGEMENT_EVENTS.SKILL_GAP_UPDATED, userId, data);
}

/**
 * onNewJobMatch(userId, data)
 *
 * Call this when the Job Matching Engine finds a match above the threshold.
 *
 * @param {string} userId
 * @param {Object} data  — { job_title, company?, match_score, job_id? }
 */
async function onNewJobMatch(userId, data = {}) {
  await enqueue(ENGAGEMENT_EVENTS.NEW_JOB_MATCH, userId, data);
}

/**
 * onMarketTrendUpdated(userId, data)
 *
 * Call this when the LMI engine refreshes market data for a specific user's
 * industry/role combination.
 *
 * @param {string} userId
 * @param {Object} data  — { role?, top_surging_skill?, surge_rate?, salary_change? }
 */
async function onMarketTrendUpdated(userId, data = {}) {
  await enqueue(ENGAGEMENT_EVENTS.MARKET_TREND_UPDATED, userId, data);
}

/**
 * onOpportunityDetected(userId, data)
 *
 * Call this when the AI Career Opportunity Radar detects a new opportunity.
 *
 * @param {string} userId
 * @param {Object} data  — { opportunity_title?, role?, match_score?, opportunity_id? }
 */
async function onOpportunityDetected(userId, data = {}) {
  await enqueue(ENGAGEMENT_EVENTS.OPPORTUNITY_DETECTED, userId, data);
}

/**
 * closeQueue()
 * Gracefully close the queue connection. Call during server shutdown.
 */
async function closeQueue() {
  if (_queue) {
    await _queue.close();
    _queue = null;
    logger.info('[EngagementQueue] Queue closed');
  }
}

module.exports = {
  onCvParsed,
  onSkillGapUpdated,
  onNewJobMatch,
  onMarketTrendUpdated,
  onOpportunityDetected,
  closeQueue,
  // Low-level escape hatch for custom event types
  enqueue,
};









