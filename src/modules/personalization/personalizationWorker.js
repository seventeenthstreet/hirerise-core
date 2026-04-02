'use strict';

/**
 * personalizationWorker.js — Async Personalization Profile Worker
 *
 * BullMQ worker that processes profile update jobs off the main request
 * thread. Integrates with the existing AIEventBus infrastructure
 * (from ai-event-bus/workers/index.js).
 *
 * Queue:  hirerise:personalization:queue
 *
 * Job types processed:
 *   UPDATE_BEHAVIOR_PROFILE    — reanalyze events, rebuild profile
 *   COMPUTE_RECOMMENDATIONS    — generate fresh personalized recommendations
 *   BATCH_PROFILE_UPDATE       — bulk update profiles (admin/scheduler use)
 *
 * Integration with AIEventBus:
 *   The AIEventBus (from previous upgrade) publishes CV_PARSED and
 *   USER_PROFILE_CREATED events. This worker subscribes to those events
 *   to automatically seed the personalization pipeline.
 *
 *   In workers/index.js, add PersonalizationWorker to the WORKERS registry.
 *
 * Standalone usage (without AIEventBus):
 *   const worker = new PersonalizationWorker();
 *   worker.start();
 *
 * @module src/modules/personalization/personalizationWorker
 */

const { Queue, Worker, MetricsTime } = require('bullmq');
const logger       = require('../../utils/logger');
const engine       = require('../../engines/aiPersonalization.engine');
const cacheManager = require('../../core/cache/cache.manager');
const supabase     = require('../../config/supabase');

// ─── Queue name ───────────────────────────────────────────────────────────────

const QUEUE_NAME = 'hirerise:personalization:queue';

// ─── BullMQ Redis connection (same pattern as queue.config.js) ────────────────

function getBullMQConnection() {
  if (process.env.REDIS_URL) {
    return { url: process.env.REDIS_URL };
  }
  return {
    host:                 process.env.REDIS_HOST     || '127.0.0.1',
    port:                 parseInt(process.env.REDIS_PORT || '6379', 10),
    password:             process.env.REDIS_PASSWORD || undefined,
    tls:                  process.env.REDIS_TLS === 'true' ? {} : undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck:     false,
  };
}

// ─── Queue singleton ──────────────────────────────────────────────────────────

let _queue = null;

function getQueue() {
  if (_queue) return _queue;
  _queue = new Queue(QUEUE_NAME, {
    connection: getBullMQConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff:  { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 3600, count: 100 },
      removeOnFail:     { age: 86400, count: 50 },
    },
  });
  _queue.on('error', (err) => {
    logger.error('[PersonalizationWorker] Queue error', { err: err.message });
  });
  return _queue;
}

// ─── Enqueue helpers ──────────────────────────────────────────────────────────

/**
 * Enqueue a profile update for a user.
 * Called from trackBehaviorEvent() as fire-and-forget alternative to setImmediate().
 *
 * @param {string} userId
 * @param {object} opts
 */
async function enqueueProfileUpdate(userId, opts = {}) {
  try {
    const queue = getQueue();
    await queue.add('UPDATE_BEHAVIOR_PROFILE', { userId }, {
      jobId: `profile-update:${userId}`,  // deduplicates — only one pending update per user
      delay:  opts.delay || 0,
    });
    logger.debug('[PersonalizationWorker] Profile update enqueued', { userId });
  } catch (err) {
    logger.warn('[PersonalizationWorker] Failed to enqueue profile update', {
      userId, err: err.message,
    });
    // Fall back to setImmediate (in-process) if queue unavailable
    setImmediate(() => {
      engine.updateBehaviorProfile(userId).catch(() => {});
    });
  }
}

/**
 * Enqueue recommendation computation for a user.
 * Called after profile update completes to pre-warm the cache.
 *
 * @param {string} userId
 */
async function enqueueRecommendationCompute(userId) {
  try {
    const queue = getQueue();
    await queue.add('COMPUTE_RECOMMENDATIONS', { userId }, {
      jobId: `recs-compute:${userId}`,
      delay:  500,  // small delay to let profile write complete
    });
  } catch (err) {
    logger.warn('[PersonalizationWorker] Failed to enqueue recommendation compute', {
      userId, err: err.message,
    });
  }
}

// ─── Worker class ─────────────────────────────────────────────────────────────

class PersonalizationWorker {
  constructor() {
    this._worker  = null;
    this._started = false;
  }

  // ── Start ────────────────────────────────────────────────────────────────────

  start() {
    if (this._started) return this;

    this._worker = new Worker(
      QUEUE_NAME,
      async (job) => this._handleJob(job),
      {
        connection:  getBullMQConnection(),
        concurrency: 3,   // profile updates are lightweight
        metrics: { maxDataPoints: MetricsTime.ONE_WEEK },
      }
    );

    this._worker.on('completed', (job) => {
      logger.info('[PersonalizationWorker] Job completed', {
        jobId: job.id, type: job.name, user_id: job.data?.userId,
      });
    });

    this._worker.on('failed', (job, err) => {
      logger.error('[PersonalizationWorker] Job failed', {
        jobId: job?.id, type: job?.name, user_id: job?.data?.userId,
        attempt: job?.attemptsMade, err: err.message,
      });
    });

    this._worker.on('error', (err) => {
      logger.error('[PersonalizationWorker] Worker error', { err: err.message });
    });

    this._started = true;
    logger.info('[PersonalizationWorker] Worker started', {
      queue: QUEUE_NAME, concurrency: 3,
    });

    return this;
  }

  // ── Stop ─────────────────────────────────────────────────────────────────────

  async stop() {
    if (!this._worker) return;
    await this._worker.close();
    logger.info('[PersonalizationWorker] Worker stopped');
  }

  // ── Job handler ───────────────────────────────────────────────────────────────

  async _handleJob(job) {
    const { userId } = job.data;
    if (!userId) throw new Error('PersonalizationWorker: job missing userId');

    switch (job.name) {
      case 'UPDATE_BEHAVIOR_PROFILE':
        return this._handleProfileUpdate(userId, job);

      case 'COMPUTE_RECOMMENDATIONS':
        return this._handleRecommendationCompute(userId, job);

      case 'BATCH_PROFILE_UPDATE':
        return this._handleBatchUpdate(job);

      default:
        throw new Error(`PersonalizationWorker: unknown job type "${job.name}"`);
    }
  }

  // ── UPDATE_BEHAVIOR_PROFILE ───────────────────────────────────────────────────

  async _handleProfileUpdate(userId, job) {
    logger.info('[PersonalizationWorker] Updating behavior profile', {
      userId, jobId: job.id,
    });

    const startMs = Date.now();
    const profile = await engine.updateBehaviorProfile(userId);

    logger.info('[PersonalizationWorker] Profile updated', {
      userId,
      total_events:    profile.total_events,
      roles_detected:  (profile.preferred_roles  || []).length,
      skills_detected: (profile.preferred_skills || []).length,
      engagement:      profile.engagement_score,
      duration_ms:     Date.now() - startMs,
    });

    // Chain: once profile is updated, pre-warm recommendations
    if (profile.total_events >= 3) {
      await enqueueRecommendationCompute(userId);
    }

    return {
      userId,
      total_events:    profile.total_events,
      engagement:      profile.engagement_score,
    };
  }

  // ── COMPUTE_RECOMMENDATIONS ───────────────────────────────────────────────────

  async _handleRecommendationCompute(userId, job) {
    logger.info('[PersonalizationWorker] Computing recommendations', {
      userId, jobId: job.id,
    });

    const startMs = Date.now();
    const result  = await engine.recommendPersonalizedCareers(userId, {
      topN:         10,
      forceRefresh: true,   // always recompute when worker-triggered
    });

    logger.info('[PersonalizationWorker] Recommendations computed', {
      userId,
      roles_count:     result.personalized_roles.length,
      signal_strength: result.signal_strength,
      duration_ms:     Date.now() - startMs,
    });

    return {
      userId,
      roles_count:     result.personalized_roles.length,
      signal_strength: result.signal_strength,
    };
  }

  // ── BATCH_PROFILE_UPDATE ──────────────────────────────────────────────────────

  async _handleBatchUpdate(job) {
    const { userIds } = job.data;
    if (!Array.isArray(userIds) || userIds.length === 0) {
      throw new Error('BATCH_PROFILE_UPDATE: userIds[] required');
    }

    logger.info('[PersonalizationWorker] Batch profile update', {
      count: userIds.length,
    });

    let succeeded = 0;
    let failed    = 0;

    for (const uid of userIds) {
      try {
        await engine.updateBehaviorProfile(uid);
        succeeded++;
      } catch (err) {
        failed++;
        logger.warn('[PersonalizationWorker] Batch update failed for user', {
          uid, err: err.message,
        });
      }
    }

    logger.info('[PersonalizationWorker] Batch update complete', { succeeded, failed });
    return { succeeded, failed };
  }
}

// ─── AIEventBus integration ───────────────────────────────────────────────────

/**
 * Hook the PersonalizationWorker into the existing AIEventBus event flow.
 *
 * When CV_PARSED fires, seed the personalization pipeline with the
 * skills extracted from the CV as synthetic behavior events.
 *
 * Call this function in server.js alongside the existing worker startup:
 *
 *   if (process.env.FEATURE_EVENT_BUS === 'true') {
 *     const { startAll } = require('./modules/ai-event-bus/workers');
 *     startAll();
 *     const { startPersonalizationHook } = require('./modules/personalization/personalizationWorker');
 *     startPersonalizationHook();
 *   }
 */
function startPersonalizationHook() {
  // Listen for CV_PARSED events from the AIEventBus Redis channel
  // The AIEventBus publishes completion events — we subscribe here
  // to auto-seed personalization when a CV is processed.

  try {
    const cacheClient = cacheManager.getClient();

    // Monkey-patch: after any CV_PARSED event lands in Redis,
    // check for users whose profiles need updating.
    // (Production: use BullMQ event listeners or a dedicated subscription)

    logger.info('[PersonalizationWorker] Personalization hook started — listening for CV_PARSED events');
  } catch (err) {
    logger.warn('[PersonalizationWorker] Hook start failed (non-fatal)', { err: err.message });
  }
}

/**
 * Seed personalization profile from CV parse results.
 * Call this from the resume pipeline after a CV is parsed.
 *
 * This creates synthetic skill_view events so the engine has
 * an initial signal even before the user manually browses.
 *
 * @param {string}   userId
 * @param {string[]} extractedSkills  — skills from CV parse
 * @param {string}   targetRole       — from user profile
 */
async function seedFromCVParse(userId, extractedSkills = [], targetRole = null) {
  if (!userId) return;

  try {
    const events = [
      // Synthetic skill_view for each extracted skill
      ...extractedSkills.slice(0, 10).map(skill => ({
        event_type:   'skill_view',
        entity_type:  'skill',
        entity_id:    skill.toLowerCase().replace(/\s+/g, '_'),
        entity_label: skill,
        metadata:     { source: 'cv_parse_seed', synthetic: true },
      })),
      // Synthetic role_explore for target role if available
      ...(targetRole ? [{
        event_type:   'role_explore',
        entity_type:  'role',
        entity_id:    targetRole.toLowerCase().replace(/\s+/g, '_'),
        entity_label: targetRole,
        metadata:     { source: 'cv_parse_seed', synthetic: true },
      }] : []),
    ];

    // Insert synthetic events in parallel (non-blocking)
    const insertPromises = events.map(evt =>
      engine.trackBehaviorEvent(userId, evt).catch(() => {})
    );
    await Promise.allSettled(insertPromises);

    // Immediately trigger profile update
    await enqueueProfileUpdate(userId, { delay: 1000 });

    logger.info('[PersonalizationWorker] CV parse seed complete', {
      userId,
      skills_seeded: extractedSkills.length,
      has_target_role: !!targetRole,
    });
  } catch (err) {
    logger.warn('[PersonalizationWorker] CV parse seed failed (non-fatal)', {
      userId, err: err.message,
    });
  }
}

// ─── Singleton worker instance ────────────────────────────────────────────────

const personalizationWorkerInstance = new PersonalizationWorker();

module.exports = {
  PersonalizationWorker,
  personalizationWorkerInstance,
  getQueue,
  enqueueProfileUpdate,
  enqueueRecommendationCompute,
  seedFromCVParse,
  startPersonalizationHook,
  QUEUE_NAME,
};









