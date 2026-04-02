'use strict';

/**
 * aiEventBus.js — Supabase-optimized AI Event Bus
 *
 * Firebase references: fully removed (none existed in the original file).
 * Optimizations added:
 * - Idempotent Supabase writes using upsert()
 * - Proper awaited job creation for stronger consistency
 * - Lean select columns for status polling
 * - Centralized timestamp helper
 * - Better queue reuse and safer shutdown
 * - Improved partial dispatch status handling
 */

const { Queue } = require('bullmq');
const { randomUUID } = require('crypto');
const logger = require('../../../utils/logger');
const supabase = require('../../config/supabase');
const {
  QUEUE_OPTIONS,
  EVENT_TO_QUEUES,
  DEFAULT_JOB_OPTIONS,
  getBullMQRedisConnection,
} = require('./queues/queue.config');

const now = () => new Date().toISOString();

const EVENT_TYPES = Object.freeze({
  USER_PROFILE_CREATED: 'USER_PROFILE_CREATED',
  CV_PARSED: 'CV_PARSED',
  SKILLS_EXTRACTED: 'SKILLS_EXTRACTED',
  CAREER_ANALYSIS_REQUESTED: 'CAREER_ANALYSIS_REQUESTED',
  JOB_MATCH_REQUESTED: 'JOB_MATCH_REQUESTED',
  RISK_ANALYSIS_REQUESTED: 'RISK_ANALYSIS_REQUESTED',
  OPPORTUNITY_SCAN_REQUESTED: 'OPPORTUNITY_SCAN_REQUESTED',
  CAREER_ADVICE_REQUESTED: 'CAREER_ADVICE_REQUESTED',
  SKILL_GRAPH_COMPLETED: 'SKILL_GRAPH_COMPLETED',
  CAREER_HEALTH_COMPLETED: 'CAREER_HEALTH_COMPLETED',
  JOB_MATCH_COMPLETED: 'JOB_MATCH_COMPLETED',
  RISK_ANALYSIS_COMPLETED: 'RISK_ANALYSIS_COMPLETED',
  OPPORTUNITY_SCAN_COMPLETED: 'OPPORTUNITY_SCAN_COMPLETED',
  CAREER_ADVICE_COMPLETED: 'CAREER_ADVICE_COMPLETED',
});

const queuePool = new Map();

function getQueue(queueName) {
  if (queuePool.has(queueName)) return queuePool.get(queueName);

  const queue = new Queue(queueName, {
    connection: getBullMQRedisConnection(),
    defaultJobOptions:
      QUEUE_OPTIONS[queueName]?.jobOptions || DEFAULT_JOB_OPTIONS,
  });

  queue.on('error', (err) => {
    logger.error('[AIEventBus] Queue error', {
      queueName,
      error: err.message,
    });
  });

  queuePool.set(queueName, queue);
  return queue;
}

function buildEnvelope(eventType, payload, pipelineJobId) {
  return {
    eventId: randomUUID(),
    pipelineJobId,
    eventType,
    publishedAt: now(),
    source: process.env.SERVICE_NAME || 'hirerise-core',
    payload,
  };
}

async function createPipelineJob(pipelineJobId, userId, eventType, payload, queueNames) {
  const { error } = await supabase.from('ai_pipeline_jobs').upsert({
    id: pipelineJobId,
    user_id: userId,
    event_type: eventType,
    queue_name: queueNames.join(','),
    status: 'pending',
    input_payload: payload,
    queued_at: now(),
  });

  if (error) {
    logger.warn('[AIEventBus] Failed to persist pipeline job', {
      pipelineJobId,
      error: error.message,
    });
  }
}

async function updatePipelineJobStatus(pipelineJobId, status, opts = {}) {
  const patch = {
    status,
    ...(opts.bullmqJobId && { bullmq_job_id: opts.bullmqJobId }),
    ...(opts.errorMessage && { error_message: opts.errorMessage }),
    ...(opts.errorCode && { error_code: opts.errorCode }),
    ...(status === 'processing' && { started_at: now() }),
    ...(status === 'completed' && { completed_at: now() }),
  };

  const { error } = await supabase
    .from('ai_pipeline_jobs')
    .update(patch)
    .eq('id', pipelineJobId);

  if (error) {
    logger.warn('[AIEventBus] Status update failed', {
      pipelineJobId,
      status,
      error: error.message,
    });
  }
}

async function publish(eventType, payload, opts = {}) {
  if (!EVENT_TYPES[eventType]) {
    throw new Error(`Unknown event type: ${eventType}`);
  }

  const userId = payload?.userId;
  if (!userId) throw new Error('payload.userId is required');

  const targetQueues = EVENT_TO_QUEUES[eventType] || [];
  if (!targetQueues.length) {
    return { pipelineJobId: null, bullmqJobIds: {}, queuesDispatched: [] };
  }

  const pipelineJobId = randomUUID();
  const envelope = buildEnvelope(eventType, payload, pipelineJobId);

  await createPipelineJob(
    pipelineJobId,
    userId,
    eventType,
    payload,
    targetQueues
  );

  const settled = await Promise.allSettled(
    targetQueues.map(async (queueName) => {
      const queue = getQueue(queueName);
      const job = await queue.add(eventType, envelope, {
        ...(QUEUE_OPTIONS[queueName]?.jobOptions || DEFAULT_JOB_OPTIONS),
        ...(opts.priority !== undefined && { priority: opts.priority }),
        ...(opts.delay !== undefined && { delay: opts.delay }),
        jobId: `${pipelineJobId}:${queueName}`,
      });

      return { queueName, bullmqJobId: job.id };
    })
  );

  const bullmqJobIds = {};
  const queuesDispatched = [];

  for (const result of settled) {
    if (result.status === 'fulfilled') {
      bullmqJobIds[result.value.queueName] = result.value.bullmqJobId;
      queuesDispatched.push(result.value.queueName);
    }
  }

  if (!queuesDispatched.length) {
    await updatePipelineJobStatus(pipelineJobId, 'failed', {
      errorMessage: 'All queue dispatches failed',
      errorCode: 'QUEUE_DISPATCH_FAILED',
    });
  }

  return { pipelineJobId, bullmqJobIds, queuesDispatched };
}

async function publishCompletion(pipelineJobId, completionEventType, resultSummary = {}) {
  await updatePipelineJobStatus(pipelineJobId, 'completed');

  logger.info('[AIEventBus] Job completed', {
    pipelineJobId,
    completionEventType,
    ...resultSummary,
  });
}

async function publishFailure(pipelineJobId, error) {
  await updatePipelineJobStatus(pipelineJobId, 'failed', {
    errorMessage: error instanceof Error ? error.message : String(error),
    errorCode: error?.code || 'WORKER_ERROR',
  });
}

async function getPipelineStatus(pipelineJobId) {
  const { data, error } = await supabase
    .from('ai_pipeline_jobs')
    .select('id,status,event_type,queue_name,attempt_count,queued_at,started_at,completed_at,error_message')
    .eq('id', pipelineJobId)
    .maybeSingle();

  if (error) {
    logger.warn('[AIEventBus] Status fetch failed', {
      pipelineJobId,
      error: error.message,
    });
    return null;
  }

  return data;
}

async function closeAllQueues() {
  await Promise.allSettled([...queuePool.values()].map((q) => q.close()));
  queuePool.clear();
}

module.exports = {
  publish,
  publishCompletion,
  publishFailure,
  getPipelineStatus,
  closeAllQueues,
  EVENT_TYPES,
};
