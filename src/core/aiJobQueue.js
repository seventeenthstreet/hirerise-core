'use strict';

const crypto = require('crypto');
const logger = require('../utils/logger');
const {
  AppError,
  ErrorCodes,
} = require('../middleware/errorHandler');

// Wave 1 alignment:
// unified with hardened async job repository/table naming.
const JOB_TABLE =
  process.env.AI_JOB_TABLE || 'automation_jobs';

const JOB_STATUS = Object.freeze({
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
});

const MAX_RETRIES = 2;
const JOB_TIMEOUT_MS = 20000;
const RETRY_BACKOFF_MS = 1500;

function getSupabase() {
  return require('../config/supabase').supabase;
}

function buildDeterministicJobId({
  userId,
  operationType,
  payload,
  dedupeKey,
}) {
  const signature =
    dedupeKey ||
    `${userId}:${operationType}:${payload.resumeId || 'none'}:${payload.tier || 'none'}`;

  return crypto
    .createHash('sha256')
    .update(signature)
    .digest('hex')
    .slice(0, 32);
}

function createJobDoc(jobId, userId, operationType, payload) {
  const now = new Date().toISOString();

  return {
    id: jobId,
    user_id: userId,
    operation_type: operationType,
    status: JOB_STATUS.PENDING,
    payload: {
      ...payload,
      userId,
    },
    result: null,
    error: null,
    retries: 0,
    created_at: now,
    updated_at: now,
    started_at: null,
    completed_at: null,
  };
}

async function updateJob(jobId, fields) {
  const supabase = getSupabase();

  const { error } = await supabase
    .from(JOB_TABLE)
    .update({
      ...fields,
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId);

  if (error) {
    throw new AppError(
      'Failed to update job',
      500,
      { jobId, table: JOB_TABLE },
      ErrorCodes.DB_ERROR
    );
  }
}

function dispatch(jobId, operationType, payload, delay = 0) {
  setTimeout(() => {
    processAiJob(jobId, operationType, payload).catch((err) => {
      logger.error('[AIJobQueue] Background failure', {
        jobId,
        error: err.message,
      });
    });
  }, delay);
}

async function enqueueAiJob({
  userId,
  operationType,
  payload = {},
  dedupeKey,
}) {
  if (!userId) {
    throw new AppError(
      'userId required',
      400,
      null,
      ErrorCodes.VALIDATION_ERROR
    );
  }

  if (!operationType) {
    throw new AppError(
      'operationType required',
      400,
      null,
      ErrorCodes.VALIDATION_ERROR
    );
  }

  const supabase = getSupabase();

  const jobId = buildDeterministicJobId({
    userId,
    operationType,
    payload,
    dedupeKey,
  });

  const { data: existingJob } = await supabase
    .from(JOB_TABLE)
    .select('id,status')
    .eq('id', jobId)
    .maybeSingle();

  if (existingJob) {
    return {
      jobId,
      pollUrl: `/analysis/jobs/${jobId}`,
      reused: true,
    };
  }

  const jobDoc = createJobDoc(
    jobId,
    userId,
    operationType,
    payload
  );

  const { error } = await supabase
    .from(JOB_TABLE)
    .insert(jobDoc);

  if (error) {
    throw new AppError(
      'Failed to enqueue job',
      500,
      { table: JOB_TABLE },
      ErrorCodes.DB_ERROR
    );
  }

  logger.info('[AIJobQueue] Job enqueued', {
    jobId,
    operationType,
  });

  dispatch(jobId, operationType, jobDoc.payload);

  return {
    jobId,
    pollUrl: `/analysis/jobs/${jobId}`,
    reused: false,
  };
}

async function acquireJobLock(jobId) {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from(JOB_TABLE)
    .update({
      status: JOB_STATUS.PROCESSING,
      started_at: new Date().toISOString(),
    })
    .eq('id', jobId)
    .eq('status', JOB_STATUS.PENDING)
    .select('id,status')
    .maybeSingle();

  if (error) {
    logger.warn('[AIJobQueue] lock acquire failed', {
      jobId,
      error: error.message,
    });
    return false;
  }

  return Boolean(data);
}

async function processAiJob(jobId, operationType, payload = {}) {
  const supabase = getSupabase();

  const locked = await acquireJobLock(jobId);

  if (!locked) {
    logger.warn('[AIJobQueue] Skipped (already processing)', {
      jobId,
    });
    return;
  }

  try {
    const result = await Promise.race([
      executeOperation(operationType, payload),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('JOB_TIMEOUT')),
          JOB_TIMEOUT_MS
        )
      ),
    ]);

    await updateJob(jobId, {
      status: JOB_STATUS.COMPLETED,
      result:
        result && typeof result === 'object'
          ? result
          : { value: result },
      error: null,
      completed_at: new Date().toISOString(),
    });

    logger.info('[AIJobQueue] Job completed', { jobId });
  } catch (err) {
    logger.error('[AIJobQueue] Job failed', {
      jobId,
      error: err.message,
    });

    const { data } = await supabase
      .from(JOB_TABLE)
      .select('retries,status')
      .eq('id', jobId)
      .maybeSingle();

    const retries = Number(data?.retries || 0);
    const status = data?.status;

    if (
      status === JOB_STATUS.PROCESSING &&
      retries < MAX_RETRIES
    ) {
      await updateJob(jobId, {
        status: JOB_STATUS.PENDING,
        retries: retries + 1,
      });

      const delay =
        RETRY_BACKOFF_MS * Math.max(1, retries + 1);

      logger.warn('[AIJobQueue] Retrying job', {
        jobId,
        retries: retries + 1,
        delay,
      });

      dispatch(jobId, operationType, payload, delay);
      return;
    }

    await updateJob(jobId, {
      status: JOB_STATUS.FAILED,
      error: { message: err.message },
    });
  }
}

async function executeOperation(operationType, payload = {}) {
  if (
    operationType === 'chi_calculation' ||
    operationType === 'fullAnalysis' ||
    operationType === 'jobMatchAnalysis'
  ) {
    const { runFullPipeline } = require('./pipeline.connector');

    return runFullPipeline({
      user_id: payload.userId,
      resumeId: payload.resumeId,
      tier: payload.tier,
      requestSignature:
        payload.requestSignature ?? null,
    });
  }

  if (operationType === 'jobSpecificCV') {
    const {
      scoreResume,
    } = require('../modules/resume/resume.service');

    return scoreResume(
      payload.userId,
      payload.resumeId
    );
  }

  throw new AppError(
    `Unknown operationType: ${operationType}`,
    400,
    { operationType },
    ErrorCodes.VALIDATION_ERROR
  );
}

async function getJobStatus(jobId, userId) {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from(JOB_TABLE)
    .select('*')
    .eq('id', jobId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error || !data) {
    throw new AppError(
      'Job not found',
      404,
      { jobId },
      ErrorCodes.NOT_FOUND
    );
  }

  return {
    jobId,
    status: data.status,
    result: data.result,
    error: data.error,
    completedAt: data.completed_at,
    retries: data.retries,
  };
}

module.exports = {
  enqueueAiJob,
  getJobStatus,
  processAiJob,
};