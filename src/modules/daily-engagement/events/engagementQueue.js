'use strict';

/**
 * modules/daily-engagement/events/engagementQueue.js
 *
 * Production-grade BullMQ publisher for Daily Engagement.
 *
 * Supabase-ready improvements:
 * - Firebase-free event architecture
 * - stable Redis singleton config
 * - deterministic dedupe job IDs
 * - payload serialization safety
 * - better retry semantics
 * - stronger logging consistency
 * - graceful shutdown safety
 */

const crypto = require('crypto');
const logger = require('../../../utils/logger');
const {
  ENGAGEMENT_EVENTS,
  QUEUE_NAME,
} = require('../models/engagement.constants');

let _queue = null;
let _queueInitFailed = false;

/**
 * Shared immutable Redis connection config.
 */
const REDIS_CONNECTION = Object.freeze({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: Number.parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
});

/**
 * Convert payload into Redis-safe JSON structure.
 */
function sanitizePayload(payload = {}) {
  return JSON.parse(
    JSON.stringify(payload, (_, value) => {
      if (typeof value === 'bigint') return Number(value);
      if (value instanceof Date) return value.toISOString();
      if (typeof value === 'undefined') return null;
      return value;
    })
  );
}

/**
 * Stable dedupe job ID.
 * Prevents replay storms from repeated identical events.
 */
function buildJobId(eventName, userId, payload) {
  const hash = crypto
    .createHash('sha1')
    .update(JSON.stringify(payload))
    .digest('hex')
    .slice(0, 12);

  return `${eventName}:${userId}:${hash}`;
}

/**
 * Queue singleton with lazy init.
 */
function getQueue() {
  if (_queue) return _queue;
  if (_queueInitFailed) return null;

  let Queue;
  try {
    ({ Queue } = require('bullmq'));
  } catch (err) {
    _queueInitFailed = true;

    logger.warn('[EngagementQueue] bullmq unavailable — queue disabled', {
      error: err.message,
      queue: QUEUE_NAME,
    });

    return null;
  }

  _queue = new Queue(QUEUE_NAME, {
    connection: REDIS_CONNECTION,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
      removeOnComplete: {
        count: 500,
      },
      removeOnFail: {
        count: 200,
      },
    },
  });

  _queue.on('error', (err) => {
    logger.error('[EngagementQueue] Queue error', {
      queue: QUEUE_NAME,
      error: err.message,
    });
  });

  logger.info('[EngagementQueue] Queue initialized', {
    queue: QUEUE_NAME,
  });

  return _queue;
}

/**
 * Core non-blocking enqueue helper.
 */
async function enqueue(eventName, userId, payload = {}) {
  const queue = getQueue();
  if (!queue || !userId) return;

  const safePayload = sanitizePayload(payload);
  const jobId = buildJobId(eventName, userId, safePayload);

  try {
    const job = await queue.add(
      eventName,
      {
        userId,
        payload: safePayload,
        emitted_at: new Date().toISOString(),
      },
      {
        jobId,
      }
    );

    logger.debug('[EngagementQueue] Event enqueued', {
      eventName,
      userId,
      jobId: job.id,
      queue: QUEUE_NAME,
    });
  } catch (err) {
    logger.warn('[EngagementQueue] Enqueue failed (non-fatal)', {
      eventName,
      userId,
      jobId,
      queue: QUEUE_NAME,
      error: err.message,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Typed publishers
// ─────────────────────────────────────────────────────────────────────────────

async function onCvParsed(userId, data = {}) {
  await enqueue(ENGAGEMENT_EVENTS.CV_PARSED, userId, data);
}

async function onSkillGapUpdated(userId, data = {}) {
  await enqueue(ENGAGEMENT_EVENTS.SKILL_GAP_UPDATED, userId, data);
}

async function onNewJobMatch(userId, data = {}) {
  await enqueue(ENGAGEMENT_EVENTS.NEW_JOB_MATCH, userId, data);
}

async function onMarketTrendUpdated(userId, data = {}) {
  await enqueue(ENGAGEMENT_EVENTS.MARKET_TREND_UPDATED, userId, data);
}

async function onOpportunityDetected(userId, data = {}) {
  await enqueue(ENGAGEMENT_EVENTS.OPPORTUNITY_DETECTED, userId, data);
}

/**
 * Graceful shutdown hook.
 */
async function closeQueue() {
  if (!_queue) return;

  try {
    await _queue.close();

    logger.info('[EngagementQueue] Queue closed', {
      queue: QUEUE_NAME,
    });
  } finally {
    _queue = null;
  }
}

module.exports = {
  onCvParsed,
  onSkillGapUpdated,
  onNewJobMatch,
  onMarketTrendUpdated,
  onOpportunityDetected,
  closeQueue,
  enqueue,
};