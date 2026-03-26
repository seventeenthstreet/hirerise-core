'use strict';

/**
 * BaseWorker.js — PHASE 1: Worker Idempotency Foundation
 *
 * WHY IDEMPOTENCY MATTERS:
 *   Cloud Tasks (and all message queue systems) guarantee at-least-once delivery.
 *   If a worker processes a job and the Firestore write times out before returning
 *   200 to the queue, the queue retries the job. Without idempotency, the job
 *   runs twice: duplicate CHI records, double credit deductions, duplicate
 *   resume scores.
 *
 *   Even with our current setInterval workers, a server restart mid-job
 *   causes the same problem.
 *
 * SOLUTION: Idempotency key stored in Redis with a 48-hour TTL.
 *
 * KEY STRUCTURE:
 *   worker:idempotency:{jobType}:{idempotencyKey}
 *
 *   idempotencyKey should be: hash(userId + jobType + contentHash)
 *   This means identical inputs = same key = second run skipped.
 *
 * LIFECYCLE:
 *   1. Check Redis for idempotencyKey
 *   2. If found: return cached result immediately (job already completed)
 *   3. If not found: run the job
 *   4. On success: store result in Redis with 48h TTL + jitter
 *   5. On failure: do NOT store — allow retry
 *
 * PHASE-4 UPDATE — TTL JITTER:
 *   Added jitter (0–IDEMPOTENCY_JITTER_MAX seconds) to the 48-hour base TTL.
 *   When many jobs complete in a deployment burst, their idempotency keys
 *   would all expire at the same time. Jitter spreads expiry across a
 *   10-minute window, preventing a simultaneous flood of re-processable jobs.
 *
 * USAGE:
 *   class MyWorker extends BaseWorker {
 *     async process(payload) {
 *       // Your job logic here
 *       return { status: 'done', recordId: '...' };
 *     }
 *   }
 *
 *   const worker = new MyWorker('resume-scoring');
 *   await worker.run(payload, idempotencyKey);
 */

const crypto = require('crypto');
const logger  = require('../../utils/logger');

const IDEMPOTENCY_TTL_SECONDS  = 48 * 60 * 60; // 48 hours base TTL
const IDEMPOTENCY_JITTER_MAX   = 10 * 60;       // jitter up to 10 minutes
const KEY_PREFIX = 'worker:idempotency:';

// Lazy-load Redis client
let _redisClient = null;
function getRedis() {
  if (_redisClient) return _redisClient;
  try {
    const mgr = require('../../core/cache/cache.manager');
    const c   = mgr.getClient();
    if (c && typeof c.get === 'function') {
      _redisClient = c;
    }
  } catch { /* Redis not available */ }
  return _redisClient;
}

class BaseWorker {
  /**
   * @param {string} jobType — unique identifier for this worker type
   *                           e.g. 'resume-scoring', 'chi-calculation', 'salary-sync'
   */
  constructor(jobType) {
    if (!jobType) throw new Error('BaseWorker requires a jobType string');
    this.jobType = jobType;
  }

  /**
   * Generate a stable idempotency key from job inputs.
   * Produces the same key for identical inputs regardless of when called.
   *
   * @param {string} userId
   * @param {object|string} inputPayload — the job's input data
   * @returns {string} SHA-256 hex digest (64 chars)
   */
  static buildIdempotencyKey(userId, inputPayload) {
    const normalized = typeof inputPayload === 'string'
      ? inputPayload
      : JSON.stringify(inputPayload, Object.keys(inputPayload).sort());

    return crypto
      .createHash('sha256')
      .update(`${userId}:${normalized}`)
      .digest('hex');
  }

  /**
   * Full Redis key for this worker + idempotency key combination.
   * @param {string} idempotencyKey
   * @returns {string}
   */
  _redisKey(idempotencyKey) {
    return `${KEY_PREFIX}${this.jobType}:${idempotencyKey}`;
  }

  /**
   * Check if this job has already been completed.
   * @param {string} idempotencyKey
   * @returns {Promise<object|null>} cached result or null
   */
  async _checkIdempotency(idempotencyKey) {
    const redis = getRedis();
    if (!redis) return null;

    try {
      const cached = await redis.get(this._redisKey(idempotencyKey));
      return cached ? JSON.parse(cached) : null;
    } catch (err) {
      logger.warn(`[${this.jobType}] Idempotency check failed — proceeding without cache`, {
        idempotencyKey, err: err.message,
      });
      return null;
    }
  }

  /**
   * Mark this job as completed and store the result.
   * Applies TTL jitter to prevent simultaneous key expiry (cache stampede).
   *
   * @param {string} idempotencyKey
   * @param {object} result
   */
  async _markComplete(idempotencyKey, result) {
    const redis = getRedis();
    if (!redis) return;

    try {
      const value = JSON.stringify({
        completedAt: new Date().toISOString(),
        jobType:     this.jobType,
        result,
      });

      // Apply jitter: 48 h base + random 0–10 min to prevent stampede
      const jitter = Math.floor(Math.random() * IDEMPOTENCY_JITTER_MAX);
      const ttl    = IDEMPOTENCY_TTL_SECONDS + jitter;

      await redis.set(this._redisKey(idempotencyKey), value, 'EX', ttl);
    } catch (err) {
      logger.warn(`[${this.jobType}] Failed to store idempotency result`, {
        idempotencyKey, err: err.message,
      });
      // Non-fatal: job completed successfully, idempotency just won't work for this run
    }
  }

  /**
   * The method subclasses must implement.
   * @param {object} payload
   * @returns {Promise<object>} result
   */
  async process(_payload) {
    throw new Error(`[${this.jobType}] process() must be implemented by subclass`);
  }

  /**
   * Run the job with idempotency protection.
   *
   * @param {object}  payload          — job input data
   * @param {string}  idempotencyKey   — stable key for this logical job
   *                                     use BaseWorker.buildIdempotencyKey() to generate
   * @returns {Promise<{ result: object, fromCache: boolean }>}
   */
  async run(payload, idempotencyKey) {
    if (!idempotencyKey) {
      throw new Error(`[${this.jobType}] idempotencyKey is required`);
    }

    const start = Date.now();

    // ── Check idempotency cache ────────────────────────────────────────────
    const cached = await this._checkIdempotency(idempotencyKey);
    if (cached) {
      logger.info(`[${this.jobType}] Idempotency hit — returning cached result`, {
        idempotencyKey,
        completedAt: cached.completedAt,
      });
      return { result: cached.result, fromCache: true };
    }

    // ── Run job ────────────────────────────────────────────────────────────
    logger.info(`[${this.jobType}] Starting job`, { idempotencyKey });

    let result;
    try {
      result = await this.process(payload);
    } catch (err) {
      logger.error(`[${this.jobType}] Job failed`, {
        idempotencyKey,
        durationMs: Date.now() - start,
        err: err.message,
      });
      throw err; // Do NOT mark complete — allow retry
    }

    // ── Mark complete ──────────────────────────────────────────────────────
    await this._markComplete(idempotencyKey, result);

    logger.info(`[${this.jobType}] Job completed`, {
      idempotencyKey,
      durationMs: Date.now() - start,
    });

    return { result, fromCache: false };
  }

  /**
   * Manually invalidate an idempotency key (e.g., for forced reprocessing).
   * Admin use only.
   * @param {string} idempotencyKey
   */
  async invalidate(idempotencyKey) {
    const redis = getRedis();
    if (!redis) return;
    try {
      await redis.del(this._redisKey(idempotencyKey));
      logger.info(`[${this.jobType}] Idempotency key invalidated`, { idempotencyKey });
    } catch (err) {
      logger.warn(`[${this.jobType}] Idempotency invalidation failed`, { err: err.message });
    }
  }
}

module.exports = BaseWorker;








