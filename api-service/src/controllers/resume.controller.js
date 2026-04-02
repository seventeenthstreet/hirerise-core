import { randomUUID } from 'crypto';
import { publishEvent, EventTypes } from '../../../shared/pubsub/index.js';
import { ResumeRepository, ScoreRepository } from '../../../shared/repositories/domain.repositories.js';
import { partitionedJobRepo as jobRepo } from '../../../shared/repositories/partitioned-jobs.repository.js';
import { validateResumeSubmission, sanitizeString } from '../../../shared/validation/index.js';
import { logger } from '../../../shared/logger/index.js';

const resumeRepo = new ResumeRepository();
const scoreRepo = new ScoreRepository();

// ─────────────────────────────────────────────────────────────────────────────
// Submit Resume
// ─────────────────────────────────────────────────────────────────────────────

export async function submitResume(req, res, next) {
  try {
    const userId = req.user.uid;

    // Validate env early
    if (!process.env.PUBSUB_RESUME_TOPIC) {
      throw new Error('Missing PUBSUB_RESUME_TOPIC environment variable');
    }

    const validation = validateResumeSubmission(req.body);
    if (!validation.valid) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: validation.error,
        requestId: req.requestId,
        timestamp: new Date().toISOString(),
      });
    }

    const { resumeStoragePath, fileName, mimeType } = req.body;

    const resumeId = randomUUID();
    const jobId = randomUUID();

    // Sanitize inputs ONCE
    const sanitizedPath = sanitizeString(resumeStoragePath, 1024);
    const sanitizedFileName = sanitizeString(fileName, 255);
    const sanitizedMimeType = sanitizeString(mimeType, 100);

    // Persist resume metadata
    await resumeRepo.create(resumeId, {
      userId,
      resumeStoragePath: sanitizedPath,
      fileName: sanitizedFileName,
      mimeType: sanitizedMimeType,
      processingStatus: 'queued',
      status: 'active',
    });

    // Create job
    await jobRepo.createJob(jobId, {
      type: 'RESUME_SCORE',
      userId,
      resumeId,
      idempotencyKey: `resume_score_${resumeId}`,
    });

    // Publish event (sanitized payload)
    await publishEvent(
      process.env.PUBSUB_RESUME_TOPIC,
      EventTypes.RESUME_SUBMITTED,
      {
        userId,
        resumeId,
        jobId,
        resumeStoragePath: sanitizedPath,
        mimeType: sanitizedMimeType,
      },
      { userId, resumeId, jobId }
    );

    logger.info('Resume submission accepted', {
      userId,
      resumeId,
      jobId,
      requestId: req.requestId,
    });

    return res.status(202).json({
      message: 'Resume submitted for processing',
      resumeId,
      jobId,
      statusUrl: `/v1/resume/${resumeId}/score`,
      requestId: req.requestId,
      timestamp: new Date().toISOString(),
    });

  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Get Resume Score
// ─────────────────────────────────────────────────────────────────────────────

export async function getResumeScore(req, res, next) {
  try {
    const userId = req.user.uid;
    const { resumeId } = req.params;

    const resume = await resumeRepo.findById(resumeId);

    if (!resume || resume.userId !== userId) {
      return res.status(404).json({
        error: 'NOT_FOUND',
        message: 'Resume not found',
        requestId: req.requestId,
        timestamp: new Date().toISOString(),
      });
    }

    if (resume.processingStatus !== 'complete') {
      return res.status(202).json({
        status: resume.processingStatus,
        message: 'Score not yet available',
        requestId: req.requestId,
        timestamp: new Date().toISOString(),
      });
    }

    const score = await scoreRepo.getLatestScore(userId, resumeId);

    if (!score) {
      return res.status(404).json({
        error: 'NOT_FOUND',
        message: 'Score not found',
        requestId: req.requestId,
        timestamp: new Date().toISOString(),
      });
    }

    return res.json({
      resumeId,
      score,
      requestId: req.requestId,
      timestamp: new Date().toISOString(),
    });

  } catch (err) {
    next(err);
  }
}