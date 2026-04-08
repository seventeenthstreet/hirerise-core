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

function responseMeta(req) {
  return {
    requestId: req.requestId,
    timestamp: new Date().toISOString()
  };
}

function buildResumeJobKey(userId, path) {
  return createHash('sha256')
    .update(`${userId}:${path}`)
    .digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// Submit Resume
// ─────────────────────────────────────────────────────────────────────────────

export async function submitResume(req, res, next) {
  try {
    const userId = req.user?.uid;

    if (!userId) {
      return res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'User authentication required',
        ...responseMeta(req)
      });
    }

    const topic = process.env.PUBSUB_RESUME_TOPIC;
    if (!topic) {
      throw new Error('Missing PUBSUB_RESUME_TOPIC environment variable');
    }

    const validation = validateResumeSubmission(req.body);
    if (!validation.valid) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: validation.error,
        ...responseMeta(req)
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

      return res.status(202).json({
        message: 'Resume already submitted for processing',
        resumeId: existingJob.resumeId,
        jobId: existingJob.id,
        statusUrl: `/v1/resume/${existingJob.resumeId}/score`,
        ...responseMeta(req)
      });
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

    await publishEvent(
      topic,
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

    logger.info('Resume submission accepted', {
      userId,
      resumeId,
      jobId,
      requestId: req.requestId
    });

    return res.status(202).json({
      message: 'Resume submitted for processing',
      resumeId,
      jobId,
      statusUrl: `/v1/resume/${resumeId}/score`,
      ...responseMeta(req)
    });
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
      return res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'User authentication required',
        ...responseMeta(req)
      });
    }

    const resume = await resumeRepo.findById(resumeId);

    if (!resume || resume.userId !== userId) {
      return res.status(404).json({
        error: 'NOT_FOUND',
        message: 'Resume not found',
        ...responseMeta(req)
      });
    }

    if (resume.processingStatus === 'failed') {
      return res.status(200).json({
        resumeId,
        status: 'failed',
        error: resume.processingError || 'Resume scoring failed',
        ...responseMeta(req)
      });
    }

    if (resume.processingStatus !== 'complete') {
      return res.status(202).json({
        resumeId,
        status: resume.processingStatus,
        message: 'Score not yet available',
        ...responseMeta(req)
      });
    }

    const score = await scoreRepo.getLatestScore(userId, resumeId);

    if (!score) {
      return res.status(404).json({
        error: 'NOT_FOUND',
        message: 'Score not found',
        ...responseMeta(req)
      });
    }

    return res.status(200).json({
      resumeId,
      status: 'complete',
      score,
      ...responseMeta(req)
    });
  } catch (error) {
    next(error);
  }
}