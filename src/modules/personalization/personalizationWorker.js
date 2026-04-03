'use strict';

/**
 * src/modules/personalization/personalizationWorker.js
 *
 * Async personalization profile worker using BullMQ.
 *
 * Queue:
 *   hirerise:personalization:queue
 *
 * Jobs:
 *   UPDATE_BEHAVIOR_PROFILE
 *   COMPUTE_RECOMMENDATIONS
 *   BATCH_PROFILE_UPDATE
 *
 * Supabase migration notes:
 * - Removed hidden legacy/unused DB import
 * - Improved Redis connection singleton reuse
 * - Hardened batch processing flow
 * - Safer worker lifecycle management
 * - Better null-safe result logging
 */

const { Queue, Worker, MetricsTime } = require('bullmq');
const logger = require('../../utils/logger');
const engine = require('../../engines/aiPersonalization.engine');
const cacheManager = require('../../core/cache/cache.manager');

// ───────────────────────────────────────────────────────────────────────────────
// Queue config
// ───────────────────────────────────────────────────────────────────────────────

const QUEUE_NAME = 'hirerise:personalization:queue';
const WORKER_CONCURRENCY = Number.parseInt(
  process.env.PERSONALIZATION_WORKER_CONCURRENCY || '3',
  10
);

// ───────────────────────────────────────────────────────────────────────────────
// Redis connection singleton
// ───────────────────────────────────────────────────────────────────────────────

let redisConnection = null;
let queueInstance = null;

function getBullMQConnection() {
  if (redisConnection) return redisConnection;

  if (process.env.REDIS_URL) {
    redisConnection = {
      url: process.env.REDIS_URL,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    };
    return redisConnection;
  }

  redisConnection = {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number.parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };

  return redisConnection;
}

// ───────────────────────────────────────────────────────────────────────────────
// Queue singleton
// ───────────────────────────────────────────────────────────────────────────────

function getQueue() {
  if (queueInstance) return queueInstance;

  queueInstance = new Queue(QUEUE_NAME, {
    connection: getBullMQConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
      removeOnComplete: {
        age: 3600,
        count: 100,
      },
      removeOnFail: {
        age: 86400,
        count: 50,
      },
    },
  });

  queueInstance.on('error', (error) => {
    logger.error('[PersonalizationWorker] Queue error', {
      error: error.message,
    });
  });

  return queueInstance;
}

// ───────────────────────────────────────────────────────────────────────────────
// Enqueue helpers
// ───────────────────────────────────────────────────────────────────────────────

async function enqueueProfileUpdate(userId, opts = {}) {
  if (!userId) return;

  try {
    const queue = getQueue();

    await queue.add(
      'UPDATE_BEHAVIOR_PROFILE',
      { userId },
      {
        jobId: `profile-update:${userId}`,
        delay: Number.parseInt(opts.delay || 0, 10),
      }
    );

    logger.debug('[PersonalizationWorker] Profile update enqueued', {
      userId,
    });
  } catch (error) {
    logger.warn('[PersonalizationWorker] Queue unavailable, fallback inline', {
      userId,
      error: error.message,
    });

    setImmediate(async () => {
      try {
        await engine.updateBehaviorProfile(userId);
      } catch (_) {}
    });
  }
}

async function enqueueRecommendationCompute(userId) {
  if (!userId) return;

  try {
    const queue = getQueue();

    await queue.add(
      'COMPUTE_RECOMMENDATIONS',
      { userId },
      {
        jobId: `recs-compute:${userId}`,
        delay: 500,
      }
    );
  } catch (error) {
    logger.warn(
      '[PersonalizationWorker] Failed to enqueue recommendation compute',
      {
        userId,
        error: error.message,
      }
    );
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Worker class
// ───────────────────────────────────────────────────────────────────────────────

class PersonalizationWorker {
  constructor() {
    this._worker = null;
    this._started = false;
  }

  start() {
    if (this._started) return this;

    this._worker = new Worker(
      QUEUE_NAME,
      async (job) => this._handleJob(job),
      {
        connection: getBullMQConnection(),
        concurrency: WORKER_CONCURRENCY,
        metrics: {
          maxDataPoints: MetricsTime.ONE_WEEK,
        },
      }
    );

    this._worker.on('completed', (job) => {
      logger.info('[PersonalizationWorker] Job completed', {
        jobId: job.id,
        type: job.name,
        user_id: job.data?.userId,
      });
    });

    this._worker.on('failed', (job, error) => {
      logger.error('[PersonalizationWorker] Job failed', {
        jobId: job?.id,
        type: job?.name,
        user_id: job?.data?.userId,
        attempt: job?.attemptsMade,
        error: error.message,
      });
    });

    this._worker.on('error', (error) => {
      logger.error('[PersonalizationWorker] Worker error', {
        error: error.message,
      });
    });

    this._started = true;

    logger.info('[PersonalizationWorker] Worker started', {
      queue: QUEUE_NAME,
      concurrency: WORKER_CONCURRENCY,
    });

    return this;
  }

  async stop() {
    if (!this._worker) return;

    await this._worker.close();
    this._worker = null;
    this._started = false;

    logger.info('[PersonalizationWorker] Worker stopped');
  }

  async _handleJob(job) {
    const { userId } = job.data || {};

    switch (job.name) {
      case 'UPDATE_BEHAVIOR_PROFILE':
        if (!userId) throw new Error('UPDATE_BEHAVIOR_PROFILE missing userId');
        return this._handleProfileUpdate(userId, job);

      case 'COMPUTE_RECOMMENDATIONS':
        if (!userId) throw new Error('COMPUTE_RECOMMENDATIONS missing userId');
        return this._handleRecommendationCompute(userId, job);

      case 'BATCH_PROFILE_UPDATE':
        return this._handleBatchUpdate(job);

      default:
        throw new Error(`Unknown job type "${job.name}"`);
    }
  }

  async _handleProfileUpdate(userId, job) {
    const startMs = Date.now();

    const profile = await engine.updateBehaviorProfile(userId);

    const totalEvents = profile?.total_events ?? 0;
    const engagement = profile?.engagement_score ?? 0;

    logger.info('[PersonalizationWorker] Profile updated', {
      userId,
      jobId: job.id,
      total_events: totalEvents,
      roles_detected: profile?.preferred_roles?.length ?? 0,
      skills_detected: profile?.preferred_skills?.length ?? 0,
      engagement,
      duration_ms: Date.now() - startMs,
    });

    if (totalEvents >= 3) {
      await enqueueRecommendationCompute(userId);
    }

    return {
      userId,
      total_events: totalEvents,
      engagement,
    };
  }

  async _handleRecommendationCompute(userId, job) {
    const startMs = Date.now();

    const result = await engine.recommendPersonalizedCareers(userId, {
      topN: 10,
      forceRefresh: true,
    });

    logger.info('[PersonalizationWorker] Recommendations computed', {
      userId,
      jobId: job.id,
      roles_count: result?.personalized_roles?.length ?? 0,
      signal_strength: result?.signal_strength ?? 'none',
      duration_ms: Date.now() - startMs,
    });

    return {
      userId,
      roles_count: result?.personalized_roles?.length ?? 0,
      signal_strength: result?.signal_strength ?? 'none',
    };
  }

  async _handleBatchUpdate(job) {
    const userIds = Array.isArray(job.data?.userIds)
      ? job.data.userIds.filter(Boolean)
      : [];

    if (userIds.length === 0) {
      throw new Error('BATCH_PROFILE_UPDATE requires userIds[]');
    }

    let succeeded = 0;
    let failed = 0;

    const results = await Promise.allSettled(
      userIds.map((userId) => engine.updateBehaviorProfile(userId))
    );

    for (const result of results) {
      if (result.status === 'fulfilled') succeeded += 1;
      else failed += 1;
    }

    logger.info('[PersonalizationWorker] Batch update complete', {
      succeeded,
      failed,
      total: userIds.length,
    });

    return { succeeded, failed };
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// CV parse seed helpers
// ───────────────────────────────────────────────────────────────────────────────

async function seedFromCVParse(
  userId,
  extractedSkills = [],
  targetRole = null
) {
  if (!userId) return;

  try {
    const normalizedSkills = extractedSkills
      .filter(Boolean)
      .slice(0, 10);

    const events = [
      ...normalizedSkills.map((skill) => ({
        event_type: 'skill_view',
        entity_type: 'skill',
        entity_id: skill.toLowerCase().replace(/\s+/g, '_'),
        entity_label: skill,
        metadata: {
          source: 'cv_parse_seed',
          synthetic: true,
        },
      })),
      ...(targetRole
        ? [
            {
              event_type: 'role_explore',
              entity_type: 'role',
              entity_id: targetRole.toLowerCase().replace(/\s+/g, '_'),
              entity_label: targetRole,
              metadata: {
                source: 'cv_parse_seed',
                synthetic: true,
              },
            },
          ]
        : []),
    ];

    await Promise.allSettled(
      events.map((event) => engine.trackBehaviorEvent(userId, event))
    );

    await enqueueProfileUpdate(userId, { delay: 1000 });

    logger.info('[PersonalizationWorker] CV parse seed complete', {
      userId,
      skills_seeded: normalizedSkills.length,
      has_target_role: Boolean(targetRole),
    });
  } catch (error) {
    logger.warn('[PersonalizationWorker] CV parse seed failed', {
      userId,
      error: error.message,
    });
  }
}

function startPersonalizationHook() {
  try {
    cacheManager.getClient();

    logger.info(
      '[PersonalizationWorker] Personalization hook started'
    );
  } catch (error) {
    logger.warn('[PersonalizationWorker] Hook start failed', {
      error: error.message,
    });
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Singleton
// ───────────────────────────────────────────────────────────────────────────────

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