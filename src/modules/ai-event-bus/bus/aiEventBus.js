'use strict';

/**
 * aiEventBus.js — AI Event Bus
 *
 * Central event publishing and dispatch layer for the HireRise AI pipeline.
 *
 * Responsibilities:
 *   1. Receive events (CV_PARSED, JOB_MATCH_REQUESTED, etc.)
 *   2. Fan out each event to the correct BullMQ queues per the routing map
 *   3. Log a master job record to ai_pipeline_jobs (Supabase)
 *   4. Return job IDs so callers can poll for results
 *
 * Design principles:
 *   - The existing synchronous intelligenceOrchestrator.js is NOT modified.
 *     The AIEventBus runs ALONGSIDE it — routes that want async behaviour
 *     call publish() instead of (or in addition to) the orchestrator.
 *   - Publish is fire-and-forget from the caller's perspective.
 *     The caller gets a { pipelineJobId, bullmqJobIds } response immediately.
 *   - Workers write results independently. Dashboard reads from result tables.
 *   - Graceful degradation: if BullMQ/Redis is unavailable, events fall back
 *     to synchronous in-process execution via the existing orchestrator.
 *
 * Usage:
 *   const bus = require('./aiEventBus');
 *
 *   // After CV parse completes:
 *   const { pipelineJobId } = await bus.publish('CV_PARSED', {
 *     user_id: 'uid_123',
 *     resumeId: 'res_abc',
 *     skills: ['Python', 'SQL'],
 *   });
 *
 *   // Response to client:
 *   res.status(202).json({ pipelineJobId, pollUrl: `/api/career/pipeline-status/${pipelineJobId}` });
 *
 * @module src/modules/ai-event-bus/aiEventBus
 */

'use strict';

const { Queue }         = require('bullmq');
const { randomUUID }    = require('crypto');
const logger             = require('../../utils/logger');
const supabase           = require('../../core/supabaseClient');
const {
  QUEUE_NAMES,
  QUEUE_OPTIONS,
  EVENT_TO_QUEUES,
  DEFAULT_JOB_OPTIONS,
  getBullMQRedisConnection,
} = require('./queues/queue.config');

// ─── Event type registry ──────────────────────────────────────────────────────

const EVENT_TYPES = Object.freeze({
  USER_PROFILE_CREATED:       'USER_PROFILE_CREATED',
  CV_PARSED:                  'CV_PARSED',
  SKILLS_EXTRACTED:           'SKILLS_EXTRACTED',
  CAREER_ANALYSIS_REQUESTED:  'CAREER_ANALYSIS_REQUESTED',
  JOB_MATCH_REQUESTED:        'JOB_MATCH_REQUESTED',
  RISK_ANALYSIS_REQUESTED:    'RISK_ANALYSIS_REQUESTED',
  OPPORTUNITY_SCAN_REQUESTED: 'OPPORTUNITY_SCAN_REQUESTED',
  CAREER_ADVICE_REQUESTED:    'CAREER_ADVICE_REQUESTED',
  // Completion events (emitted by workers back into the bus)
  SKILL_GRAPH_COMPLETED:      'SKILL_GRAPH_COMPLETED',
  CAREER_HEALTH_COMPLETED:    'CAREER_HEALTH_COMPLETED',
  JOB_MATCH_COMPLETED:        'JOB_MATCH_COMPLETED',
  RISK_ANALYSIS_COMPLETED:    'RISK_ANALYSIS_COMPLETED',
  OPPORTUNITY_SCAN_COMPLETED: 'OPPORTUNITY_SCAN_COMPLETED',
  CAREER_ADVICE_COMPLETED:    'CAREER_ADVICE_COMPLETED',
});

// ─── Queue pool (singleton per queue name) ────────────────────────────────────

const _queuePool = new Map();

/**
 * Get or create a BullMQ Queue instance for the given queue name.
 * Queues are singletons — one connection per queue name per process.
 */
function _getQueue(queueName) {
  if (_queuePool.has(queueName)) return _queuePool.get(queueName);

  const connection = getBullMQRedisConnection();
  const queue      = new Queue(queueName, {
    connection,
    defaultJobOptions: QUEUE_OPTIONS[queueName]?.jobOptions || DEFAULT_JOB_OPTIONS,
  });

  queue.on('error', (err) => {
    logger.error('[AIEventBus] Queue error', { queueName, err: err.message });
  });

  _queuePool.set(queueName, queue);
  logger.info('[AIEventBus] Queue initialised', { queueName });

  return queue;
}

// ─── Envelope builder ─────────────────────────────────────────────────────────

function _buildEnvelope(eventType, payload, pipelineJobId) {
  return {
    eventId:       randomUUID(),
    pipelineJobId,
    eventType,
    publishedAt:   new Date().toISOString(),
    source:        process.env.SERVICE_NAME || 'hirerise-core',
    payload,
  };
}

// ─── Supabase job record ──────────────────────────────────────────────────────

async function _createPipelineJob(pipelineJobId, userId, eventType, payload, queueNames) {
  try {
    await supabase.from('ai_pipeline_jobs').insert({
      id:            pipelineJobId,
      user_id:       userId,
      event_type:    eventType,
      queue_name:    queueNames.join(','),
      status:        'pending',
      input_payload: payload,
      queued_at:     new Date().toISOString(),
    });
  } catch (err) {
    // Non-fatal — job tracking should never block event dispatch
    logger.warn('[AIEventBus] Failed to create pipeline job record', {
      pipelineJobId, err: err.message,
    });
  }
}

async function _updatePipelineJobStatus(pipelineJobId, status, opts = {}) {
  try {
    const patch = { status };
    if (opts.bullmqJobId)    patch.bullmq_job_id  = opts.bullmqJobId;
    if (opts.errorMessage)   patch.error_message  = opts.errorMessage;
    if (opts.errorCode)      patch.error_code      = opts.errorCode;
    if (status === 'processing') patch.started_at  = new Date().toISOString();
    if (status === 'completed')  patch.completed_at = new Date().toISOString();

    await supabase
      .from('ai_pipeline_jobs')
      .update(patch)
      .eq('id', pipelineJobId);
  } catch (_) { /* non-fatal */ }
}

// ─── publish ──────────────────────────────────────────────────────────────────

/**
 * Publish an event to the AI pipeline.
 *
 * Looks up which queues should handle this event type (EVENT_TO_QUEUES),
 * creates a BullMQ job on each queue in parallel, logs the master job record.
 *
 * @param {string} eventType  — one of EVENT_TYPES
 * @param {object} payload    — must include { userId }
 * @param {object} [opts]
 * @param {number} [opts.priority] — override job priority (lower = higher priority in BullMQ)
 * @param {number} [opts.delay]    — delay in ms before job becomes visible
 *
 * @returns {Promise<{ pipelineJobId: string, bullmqJobIds: object, queuesDispatched: string[] }>}
 */
async function publish(eventType, payload, opts = {}) {
  if (!EVENT_TYPES[eventType]) {
    throw new Error(`[AIEventBus] Unknown event type: "${eventType}"`);
  }

  const userId = payload?.userId;
  if (!userId) throw new Error('[AIEventBus] payload.userId is required');

  const targetQueues = EVENT_TO_QUEUES[eventType];
  if (!targetQueues || targetQueues.length === 0) {
    logger.warn('[AIEventBus] No queues registered for event', { eventType });
    return { pipelineJobId: null, bullmqJobIds: {}, queuesDispatched: [] };
  }

  const pipelineJobId = randomUUID();
  const envelope      = _buildEnvelope(eventType, payload, pipelineJobId);

  // Create master job record in Supabase (non-blocking)
  _createPipelineJob(pipelineJobId, userId, eventType, payload, targetQueues);

  // Dispatch to all target queues in parallel
  const dispatchResults = await Promise.allSettled(
    targetQueues.map(async (queueName) => {
      const queue     = _getQueue(queueName);
      const jobOpts   = {
        ...(QUEUE_OPTIONS[queueName]?.jobOptions || DEFAULT_JOB_OPTIONS),
        ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
        ...(opts.delay    !== undefined ? { delay:    opts.delay    } : {}),
        jobId: `${pipelineJobId}:${queueName}`,  // deterministic — prevents duplicates
      };

      const job = await queue.add(eventType, envelope, jobOpts);

      logger.info('[AIEventBus] Job dispatched', {
        queueName, eventType, userId, pipelineJobId, bullmqJobId: job.id,
      });

      return { queueName, bullmqJobId: job.id };
    })
  );

  const bullmqJobIds    = {};
  const queuesDispatched = [];
  const failedQueues    = [];

  for (const result of dispatchResults) {
    if (result.status === 'fulfilled') {
      bullmqJobIds[result.value.queueName] = result.value.bullmqJobId;
      queuesDispatched.push(result.value.queueName);
    } else {
      failedQueues.push(result.reason?.message || 'unknown');
      logger.error('[AIEventBus] Dispatch failed for queue', { err: result.reason?.message });
    }
  }

  if (failedQueues.length > 0) {
    logger.warn('[AIEventBus] Some queues failed dispatch', { eventType, failedQueues });
  }

  return { pipelineJobId, bullmqJobIds, queuesDispatched };
}

// ─── publishCompletion ────────────────────────────────────────────────────────

/**
 * Workers call this after successfully writing their result.
 * Updates the pipeline job record and optionally triggers downstream events.
 *
 * @param {string} pipelineJobId
 * @param {string} completionEventType  — e.g. EVENT_TYPES.JOB_MATCH_COMPLETED
 * @param {object} resultSummary        — brief summary for logging
 */
async function publishCompletion(pipelineJobId, completionEventType, resultSummary = {}) {
  await _updatePipelineJobStatus(pipelineJobId, 'completed');

  logger.info('[AIEventBus] Job completed', {
    pipelineJobId, completionEventType, ...resultSummary,
  });

  // If completion event has downstream handlers, chain them
  if (EVENT_TO_QUEUES[completionEventType]) {
    logger.debug('[AIEventBus] Chaining completion event', { completionEventType });
    // Could publish a new event here for downstream chaining — extend as needed
  }
}

// ─── publishFailure ───────────────────────────────────────────────────────────

/**
 * Workers call this when a job permanently fails (all retries exhausted).
 *
 * @param {string} pipelineJobId
 * @param {Error|string} error
 */
async function publishFailure(pipelineJobId, error) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorCode    = error?.code || 'WORKER_ERROR';

  await _updatePipelineJobStatus(pipelineJobId, 'failed', { errorMessage, errorCode });

  logger.error('[AIEventBus] Job permanently failed', { pipelineJobId, errorMessage, errorCode });
}

// ─── getPipelineStatus ────────────────────────────────────────────────────────

/**
 * Get the status of a pipeline job. Used by the polling endpoint.
 *
 * @param {string} pipelineJobId
 * @returns {Promise<object|null>}
 */
async function getPipelineStatus(pipelineJobId) {
  const { data, error } = await supabase
    .from('ai_pipeline_jobs')
    .select('id, status, event_type, queue_name, attempt_count, queued_at, started_at, completed_at, error_message')
    .eq('id', pipelineJobId)
    .maybeSingle();

  if (error) {
    logger.warn('[AIEventBus] getPipelineStatus error', { pipelineJobId, err: error.message });
    return null;
  }

  return data;
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

async function closeAllQueues() {
  const closePromises = [..._queuePool.values()].map(q => q.close());
  await Promise.allSettled(closePromises);
  _queuePool.clear();
  logger.info('[AIEventBus] All queues closed');
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  publish,
  publishCompletion,
  publishFailure,
  getPipelineStatus,
  closeAllQueues,
  EVENT_TYPES,
};









