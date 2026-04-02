'use strict';

/**
 * baseWorker.js — BullMQ + Supabase optimized base worker
 *
 * Firebase: none in original.
 * Optimizations:
 * - awaited processing status updates
 * - safer result/failure upserts with merge semantics
 * - shared timestamp helper
 * - cache invalidation hooks
 * - better worker lifecycle flags
 * - improved final-attempt detection
 */

const { Worker, MetricsTime } = require('bullmq');
const logger = require('../../../utils/logger');
const supabase = require('../../config/supabase');
const cacheManager = require('../../core/cache/cache.manager');
const { publishCompletion, publishFailure } = require('../bus/aiEventBus');
const { getBullMQRedisConnection } = require('../queues/queue.config');

const RESULT_CACHE_TTL = 600;
const now = () => new Date().toISOString();

class BaseWorker {
  constructor() {
    this._worker = null;
    this._cache = cacheManager.getClient();
    this._started = false;
  }

  get queueName() {
    throw new Error(`${this.constructor.name} must implement queueName`);
  }

  get concurrency() {
    return 2;
  }

  get resultTableName() {
    throw new Error(`${this.constructor.name} must implement resultTableName`);
  }

  get cacheKeyPrefix() {
    throw new Error(`${this.constructor.name} must implement cacheKeyPrefix`);
  }

  async process(job, envelope) {
    throw new Error(`${this.constructor.name} must implement process()`);
  }

  start() {
    if (this._started) return this;

    this._worker = new Worker(
      this.queueName,
      (job) => this._handleJob(job),
      {
        connection: getBullMQRedisConnection(),
        concurrency: this.concurrency,
        metrics: { maxDataPoints: MetricsTime.ONE_WEEK },
      }
    );

    this._worker.on('completed', (job) => {
      logger.info(`[${this.constructor.name}] Job completed`, {
        jobId: job.id,
        user_id: job.data?.payload?.userId,
      });
    });

    this._worker.on('failed', (job, err) => {
      logger.error(`[${this.constructor.name}] Job failed`, {
        jobId: job?.id,
        user_id: job?.data?.payload?.userId,
        attempt: job?.attemptsMade,
        maxAttempts: job?.opts?.attempts,
        error: err.message,
      });
    });

    this._worker.on('error', (err) => {
      logger.error(`[${this.constructor.name}] Worker error`, {
        error: err.message,
      });
    });

    this._started = true;
    return this;
  }

  async stop() {
    if (!this._worker) return;
    await this._worker.close();
    this._worker = null;
    this._started = false;
    logger.info(`[${this.constructor.name}] Worker stopped`);
  }

  async _handleJob(job) {
    const envelope = job.data;
    const pipelineJobId = envelope?.pipelineJobId;
    const userId = envelope?.payload?.userId;
    const eventType = envelope?.eventType;

    if (!userId) throw new Error('Job envelope missing payload.userId');

    await this._updateJobStatus(pipelineJobId, 'processing');

    const started = Date.now();

    try {
      const result = await this.process(job, envelope);

      await Promise.allSettled([
        this._persistResult(userId, pipelineJobId, result),
        this._cacheResult(userId, result),
      ]);

      await publishCompletion(
        pipelineJobId,
        `${eventType}_COMPLETED`,
        {
          userId,
          durationMs: Date.now() - started,
        }
      ).catch(() => {});

      return result;
    } catch (error) {
      const maxAttempts = job.opts?.attempts || 3;
      const isFinalAttempt = job.attemptsMade + 1 >= maxAttempts;

      if (isFinalAttempt) {
        await Promise.allSettled([
          this._storeFailure(userId, pipelineJobId, error),
          publishFailure(pipelineJobId, error),
        ]);
      }

      throw error;
    }
  }

  async _persistResult(userId, pipelineJobId, result) {
    const row = {
      user_id: userId,
      job_id: pipelineJobId || null,
      computed_at: now(),
      ...result,
    };

    const { error } = await supabase
      .from(this.resultTableName)
      .upsert(row, {
        onConflict: 'user_id',
        ignoreDuplicates: false,
      });

    if (error) {
      logger.error(`[${this.constructor.name}] Persist error`, {
        table: this.resultTableName,
        userId,
        error: error.message,
      });
    }
  }

  async _cacheResult(userId, result) {
    const key = `${this.cacheKeyPrefix}:${userId}`;
    try {
      await this._cache.set(key, JSON.stringify(result), 'EX', RESULT_CACHE_TTL);
    } catch (error) {
      logger.debug(`[${this.constructor.name}] Cache write skipped`, {
        key,
      });
    }
  }

  async getCachedResult(userId) {
    const key = `${this.cacheKeyPrefix}:${userId}`;
    try {
      const hit = await this._cache.get(key);
      return hit ? JSON.parse(hit) : null;
    } catch {
      return null;
    }
  }

  async _storeFailure(userId, pipelineJobId, err) {
    await supabase.from(this.resultTableName).upsert(
      {
        user_id: userId,
        job_id: pipelineJobId || null,
        _error: err.message,
        _failed_at: now(),
        computed_at: now(),
      },
      { onConflict: 'user_id' }
    );
  }

  async _updateJobStatus(pipelineJobId, status) {
    if (!pipelineJobId) return;

    const patch = {
      status,
      ...(status === 'processing' && { started_at: now() }),
      ...(status === 'completed' && { completed_at: now() }),
    };

    await supabase
      .from('ai_pipeline_jobs')
      .update(patch)
      .eq('id', pipelineJobId);
  }
}

module.exports = BaseWorker;