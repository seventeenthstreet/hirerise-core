import { createHash, randomUUID } from 'crypto';
import { publishEvent, EventTypes } from '../../../shared/pubsub/index.js';
import {
  ResumeRepository,
  ScoreRepository
} from '../../../shared/repositories/domain.repositories.js';
import { partitionedJobRepo as jobRepo } from '../../../shared/repositories/partitioned-jobs.repository.js';
import {
  validateResumeSubmission,
  sanitizeString
} from '../../../shared/validation/index.js';
import { logger } from '../../../shared/logger/index.js';

const resumeRepo = new ResumeRepository();
const scoreRepo = new ScoreRepository();

const MAX_PATH_LENGTH = 1024;
const MAX_FILENAME_LENGTH = 255;
const MAX_MIME_LENGTH = 100;

/**
 * Builds the standard meta block for every response.
 * Kept as a local helper because this service uses ESM and can't
 * easily import the CJS shared/response helper without a wrapper.
 */
function responseMeta(req) {
  return {
    requestId: req.requestId,
    timestamp: new Date().toISOString(),
  };
}

/**
 * sendSuccess — local ESM wrapper matching the shared helper contract.
 * ADDITIVE: spreads `legacy` fields to top level so existing clients are unaffected.
 *
 * { success, data, meta, ...legacy }
 */
function sendSuccess(res, status, data, legacy = {}) {
  return res.status(status).json({
    success: true,
    data,
    meta: responseMeta(res.req ?? res),
    // Backward compat: old clients reading flat fields keep working
    ...legacy,
  });
}

/**
 * sendError — local ESM wrapper matching the shared helper contract.
 * ADDITIVE: includes both `error` (new) and `message` (legacy).
 *
 * { success, error, message, code?, meta, ...legacy }
 */
function sendError(res, status, message, code = null, legacy = {}) {
  const body = {
    success: false,
    error: message,     // new top-level string field
    message,            // backward compat
    meta: responseMeta(res.req ?? res),
    ...legacy,
  };
  if (code) body.code = code;
  return res.status(status).json(body);
}

function buildResumeJobKey(userId, path) {
  return createHash('sha256')
    .update(`${userId}:${path}`)
    .digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// Status normalization
//
// DB stores processing_status as 'complete' (internal value, must not change).
// The public API contract exposes 'done' as the ONLY completion state.
// This function translates at the response boundary — never at the DB layer.
//
// Allowed public values:  pending | processing | done | failed
// Deprecated public value: 'complete' → mapped to 'done'
// ─────────────────────────────────────────────────────────────────────────────
function normalizeStatus(rawStatus) {
  if (rawStatus === 'complete') return 'done';
  return rawStatus ?? 'pending';
}

// ─────────────────────────────────────────────────────────────────────────────
// Submit Resume
// ─────────────────────────────────────────────────────────────────────────────

export async function submitResume(req, res, next) {
  try {
    const userId = req.user?.uid;

    if (!userId) {
      return sendError(res, 401, 'User authentication required', 'UNAUTHORIZED', {
        error: 'UNAUTHORIZED', // backward compat: old field shape preserved
      });
    }

    const validation = validateResumeSubmission(req.body);
    if (!validation.valid) {
      return sendError(res, 400, validation.error, 'VALIDATION_ERROR', {
        error: 'VALIDATION_ERROR', // backward compat
      });
    }

    const { resumeStoragePath, fileName, mimeType } = req.body;

    const sanitizedPath = sanitizeString(
      resumeStoragePath,
      MAX_PATH_LENGTH
    );
    const sanitizedFileName = sanitizeString(
      fileName,
      MAX_FILENAME_LENGTH
    );
    const sanitizedMimeType = sanitizeString(
      mimeType,
      MAX_MIME_LENGTH
    );

    const idempotencyKey = buildResumeJobKey(userId, sanitizedPath);

    // Reuse active submission if already queued/processing
    const existingJob = await jobRepo.findByIdempotencyKey?.(
      userId,
      idempotencyKey
    );

    if (existingJob) {
      logger.info('Resume duplicate submission reused', {
        userId,
        jobId: existingJob.id,
        requestId: req.requestId
      });

      return sendSuccess(res, 202,
        {
          message:   'Resume already submitted for processing',
          resumeId:  existingJob.resumeId,
          jobId:     existingJob.id,
          statusUrl: `/v1/resume/${existingJob.resumeId}/score`,
        },
        {
          message:   'Resume already submitted for processing',
          resumeId:  existingJob.resumeId,
          jobId:     existingJob.id,
          statusUrl: `/v1/resume/${existingJob.resumeId}/score`,
        }
      );
    }

    const resumeId = randomUUID();
    const jobId = randomUUID();

    await resumeRepo.create(resumeId, {
      userId,
      resumeStoragePath: sanitizedPath,
      fileName: sanitizedFileName,
      mimeType: sanitizedMimeType,
      processingStatus: 'queued',
      status: 'active'
    });

    await jobRepo.createJob(jobId, {
      type: 'RESUME_SCORE',
      userId,
      resumeId,
      idempotencyKey
    });

    try {
      await publishEvent(
        EventTypes.RESUME_SUBMITTED,
        {
          userId,
          resumeId,
          jobId,
          resumeStoragePath: sanitizedPath,
          mimeType: sanitizedMimeType
        },
        { userId, resumeId, jobId }
      );
    } catch (publishError) {
      // Resume + job rows already persisted above. Do not lose that data —
      // log loudly and let the existing outbox retry/alerting infrastructure
      // (shared/monitoring, shared/events outbox worker) pick this up rather
      // than failing the request and orphaning the job silently.
      logger.error('Failed to publish RESUME_SUBMITTED event', {
        userId,
        resumeId,
        jobId,
        error: publishError.message,
        code: publishError.code,
        requestId: req.requestId
      });
      throw publishError;
    }

    logger.info('Resume submission accepted', {
      userId,
      resumeId,
      jobId,
      requestId: req.requestId
    });

    return sendSuccess(res, 202,
      { message: 'Resume submitted for processing', resumeId, jobId, statusUrl: `/v1/resume/${resumeId}/score` },
      { message: 'Resume submitted for processing', resumeId, jobId, statusUrl: `/v1/resume/${resumeId}/score` }
    );
  } catch (error) {
    next(error);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Get Resume Score
// ─────────────────────────────────────────────────────────────────────────────

export async function getResumeScore(req, res, next) {
  try {
    const userId = req.user?.uid;
    const { resumeId } = req.params;

    if (!userId) {
      return sendError(res, 401, 'User authentication required', 'UNAUTHORIZED', {
        error: 'UNAUTHORIZED',
      });
    }

    const resume = await resumeRepo.findById(resumeId);

    if (!resume || resume.userId !== userId) {
      return sendError(res, 404, 'Resume not found', 'NOT_FOUND', {
        error: 'NOT_FOUND',
      });
    }

    if (resume.processingStatus === 'failed') {
      const failMsg = resume.processingError || 'Resume scoring failed';
      return sendError(res, 200, failMsg, 'SCORING_FAILED', {
        resumeId,
        status: 'failed',
        error: failMsg, // backward compat — old clients read body.error
      });
    }

    // Guard: treat DB-internal 'complete' and canonical 'done' identically.
    // normalizeStatus() maps 'complete' → 'done' for all API responses.
    if (resume.processingStatus !== 'complete' && resume.processingStatus !== 'done') {
      const pendingMsg = 'Score not yet available';
      const publicStatus = normalizeStatus(resume.processingStatus);
      return sendSuccess(res, 202,
        { resumeId, status: publicStatus, message: pendingMsg },
        { resumeId, status: publicStatus, message: pendingMsg }
      );
    }

    const score = await scoreRepo.getLatestScore(userId, resumeId);

    if (!score) {
      return sendError(res, 404, 'Score not found', 'NOT_FOUND', {
        error: 'NOT_FOUND',
      });
    }

    // 'complete' is deprecated. All API responses now use 'done'.
    return sendSuccess(res, 200,
      { resumeId, status: 'done', score },
      { resumeId, status: 'done', score }
    );
  } catch (error) {
    next(error);
  }
}