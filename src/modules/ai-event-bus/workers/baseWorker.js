'use strict';

/**
 * baseWorker.js — Base AI Worker
 *
 * Abstract base class for all BullMQ AI workers.
 * Provides:
 *   - BullMQ Worker setup with correct Redis connection
 *   - Retry + backoff configuration
 *   - Supabase result persistence helpers
 *   - Redis result caching (10-minute TTL)
 *   - Structured logging per job
 *   - Failure handling (retry → log → store failure state)
 *   - Graceful shutdown hooks
 *
 * Subclasses implement:
 *   get queueName()    — QUEUE_NAMES constant
 *   get concurrency()  — how many jobs to process simultaneously
 *   async process(job) — core engine logic; must return result object
 *   get resultTableName() — Supabase table to write results to
 *   get cacheKeyPrefix()  — Redis key prefix for result caching
 *
 * @module src/modules/ai-event-bus/workers/baseWorker
 */

const { Worker, MetricsTime } = require('bullmq');
const logger                   = require('../../utils/logger');
const supabase                 = require('../../core/supabaseClient');
const cacheManager             = require('../../core/cache/cache.manager');
const { publishCompletion, publishFailure } = require('../bus/aiEventBus');
const { getBullMQRedisConnection }          = require('../queues/queue.config');

const RESULT_CACHE_TTL = 600;  // 10 minutes

class BaseWorker {
  constructor() {
    this._worker   = null;
    this._cache    = cacheManager.getClient();
    this._started  = false;
  }

  // ── Abstract properties — subclasses must override ──────────────────────────

  get queueName()       { throw new Error(`${this.constructor.name} must implement queueName`); }
  get concurrency()     { return 2; }
  get resultTableName() { throw new Error(`${this.constructor.name} must implement resultTableName`); }
  get cacheKeyPrefix()  { throw new Error(`${this.constructor.name} must implement cacheKeyPrefix`); }

  // ── Abstract method — subclasses must override ───────────────────────────────

  /**
   * Core engine logic. Called per job.
   *
   * @param {import('bullmq').Job} job
   * @param {object} envelope   — { eventType, pipelineJobId, payload: { userId, ... } }
   * @returns {Promise<object>} — result object written to Supabase + Redis
   */
  async process(job, envelope) {  // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name} must implement process()`);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  /**
   * Start the BullMQ worker. Call this in server.js or a dedicated worker process.
   */
  start() {
    if (this._started) return this;

    const connection = getBullMQRedisConnection();

    this._worker = new Worker(
      this.queueName,
      async (job) => this._handleJob(job),
      {
        connection,
        concurrency: this.concurrency,
        // Track processing time for monitoring
        metrics: {
          maxDataPoints: MetricsTime.ONE_WEEK,
        },
      }
    );

    this._worker.on('completed', (job) => {
      logger.info(`[${this.constructor.name}] Job completed`, {
        jobId: job.id, user_id: job.data?.payload?.userId,
      });
    });

    this._worker.on('failed', (job, err) => {
      logger.error(`[${this.constructor.name}] Job failed`, {
        jobId:      job?.id,
        user_id:     job?.data?.payload?.userId,
        attempt:    job?.attemptsMade,
        maxAttempts: job?.opts?.attempts,
        err:        err.message,
      });
    });

    this._worker.on('error', (err) => {
      logger.error(`[${this.constructor.name}] Worker error`, { err: err.message });
    });

    this._started = true;
    logger.info(`[${this.constructor.name}] Worker started`, {
      queue: this.queueName, concurrency: this.concurrency,
    });

    return this;
  }

  /**
   * Graceful shutdown — wait for active jobs to finish.
   */
  async stop() {
    if (!this._worker) return;
    await this._worker.close();
    logger.info(`[${this.constructor.name}] Worker stopped`);
  }

  // ── Core job handler ──────────────────────────────────────────────────────────

  async _handleJob(job) {
    const envelope      = job.data;
    const pipelineJobId = envelope?.pipelineJobId;
    const userId        = envelope?.payload?.userId;
    const eventType     = envelope?.eventType;

    if (!userId) {
      throw new Error('Job envelope missing payload.userId');
    }

    // Update pipeline job to 'processing'
    this._updateJobStatus(pipelineJobId, 'processing').catch(() => {});

    logger.info(`[${this.constructor.name}] Processing job`, {
      jobId: job.id, pipelineJobId, userId, eventType, attempt: job.attemptsMade + 1,
    });

    const startMs = Date.now();

    let result;
    try {
      result = await this.process(job, envelope);
    } catch (err) {
      // On final attempt, store failure state and emit failure event
      const isFinalAttempt = job.attemptsMade + 1 >= (job.opts?.attempts || 3);
      if (isFinalAttempt) {
        await this._storeFailure(userId, pipelineJobId, err);
        await publishFailure(pipelineJobId, err).catch(() => {});
      }
      throw err;  // Re-throw so BullMQ handles retry
    }

    const durationMs = Date.now() - startMs;

    // Write result to Supabase
    await this._persistResult(userId, pipelineJobId, result);

    // Cache result in Redis
    await this._cacheResult(userId, result);

    // Emit completion event
    await publishCompletion(pipelineJobId, `${eventType}_COMPLETED`, {
      userId, durationMs,
    }).catch(() => {});

    logger.info(`[${this.constructor.name}] Job done`, { userId, durationMs });

    return result;
  }

  // ── Persistence helpers ───────────────────────────────────────────────────────

  /**
   * Write result to the worker's dedicated Supabase table.
   * Uses UPSERT on user_id — one row per user, always latest result.
   */
  async _persistResult(userId, pipelineJobId, result) {
    try {
      const row = {
        user_id:     userId,
        job_id:      pipelineJobId || null,
        computed_at: new Date().toISOString(),
        ...result,
      };

      const { error } = await supabase
        .from(this.resultTableName)
        .upsert(row, { onConflict: 'user_id' });

      if (error) {
        logger.error(`[${this.constructor.name}] Persist error`, {
          userId, table: this.resultTableName, err: error.message,
        });
      } else {
        logger.debug(`[${this.constructor.name}] Result persisted`, {
          userId, table: this.resultTableName,
        });
      }
    } catch (err) {
      logger.error(`[${this.constructor.name}] Persist exception`, { userId, err: err.message });
    }
  }

  /**
   * Cache result in Redis with 10-minute TTL.
   */
  async _cacheResult(userId, result) {
    try {
      const key = `${this.cacheKeyPrefix}:${userId}`;
      await this._cache.set(key, JSON.stringify(result), 'EX', RESULT_CACHE_TTL);
    } catch (_) { /* non-fatal */ }
  }

  /**
   * Get cached result for a user from Redis.
   * Returns null on miss.
   */
  async getCachedResult(userId) {
    try {
      const key = `${this.cacheKeyPrefix}:${userId}`;
      const hit  = await this._cache.get(key);
      return hit ? JSON.parse(hit) : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Store failure state in the result table so dashboard can show error state.
   */
  async _storeFailure(userId, pipelineJobId, err) {
    try {
      await supabase.from(this.resultTableName).upsert({
        user_id:       userId,
        job_id:        pipelineJobId || null,
        _error:        err.message,
        _failed_at:    new Date().toISOString(),
        computed_at:   new Date().toISOString(),
      }, { onConflict: 'user_id' });
    } catch (_) { /* non-fatal */ }
  }

  /**
   * Update pipeline job status in ai_pipeline_jobs.
   */
  async _updateJobStatus(pipelineJobId, status) {
    if (!pipelineJobId) return;
    try {
      const patch = { status };
      if (status === 'processing') patch.started_at   = new Date().toISOString();
      if (status === 'completed')  patch.completed_at = new Date().toISOString();

      await supabase
        .from('ai_pipeline_jobs')
        .update(patch)
        .eq('id', pipelineJobId);
    } catch (_) { /* non-fatal */ }
  }
}

module.exports = BaseWorker;









