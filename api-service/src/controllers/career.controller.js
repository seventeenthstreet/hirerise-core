import { createHash, randomUUID } from 'crypto';
import { publishEvent, EventTypes } from '../../../shared/pubsub/index.js';
import { partitionedJobRepo as jobRepo } from '../../../shared/repositories/partitioned-jobs.repository.js';
import {
  validateCareerPathRequest,
  sanitizeString
} from '../../../shared/validation/index.js';
import { logger } from '../../../shared/logger/index.js';

const MAX_SKILLS = 50;
const MAX_TITLE_LENGTH = 200;
const MAX_SKILL_LENGTH = 100;

function buildIdempotencyKey(userId, currentTitle, targetTitle) {
  const raw = `${userId}:${currentTitle}:${targetTitle}`;
  return createHash('sha256').update(raw).digest('hex');
}

function responseMeta(req) {
  return {
    requestId: req.requestId,
    timestamp: new Date().toISOString()
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Request Career Path Analysis
// ─────────────────────────────────────────────────────────────────────────────

export async function requestCareerPath(req, res, next) {
  try {
    const userId = req.user?.uid;

    if (!userId) {
      return res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'User authentication required',
        ...responseMeta(req)
      });
    }

    const topic = process.env.PUBSUB_CAREER_TOPIC;
    if (!topic) {
      throw new Error('Missing PUBSUB_CAREER_TOPIC environment variable');
    }

    const validation = validateCareerPathRequest(req.body);
    if (!validation.valid) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: validation.error,
        ...responseMeta(req)
      });
    }

    const { currentTitle, targetTitle, currentSkills = [] } = req.body;

    const sanitizedCurrentTitle = sanitizeString(
      currentTitle,
      MAX_TITLE_LENGTH
    );
    const sanitizedTargetTitle = sanitizeString(
      targetTitle,
      MAX_TITLE_LENGTH
    );

    const sanitizedSkills = Array.isArray(currentSkills)
      ? currentSkills
          .slice(0, MAX_SKILLS)
          .map(skill => sanitizeString(skill, MAX_SKILL_LENGTH))
          .filter(Boolean)
      : [];

    const idempotencyKey = buildIdempotencyKey(
      userId,
      sanitizedCurrentTitle,
      sanitizedTargetTitle
    );

    // Fast-path: reuse existing job if repository supports idempotent lookup
    const existingJob = await jobRepo.findByIdempotencyKey?.(
      userId,
      idempotencyKey
    );

    if (existingJob) {
      logger.info('Career path duplicate request reused', {
        userId,
        jobId: existingJob.id,
        requestId: req.requestId
      });

      return res.status(202).json({
        message: 'Career path analysis already queued',
        jobId: existingJob.id,
        statusUrl: `/v1/career/result/${existingJob.id}`,
        ...responseMeta(req)
      });
    }

    const jobId = randomUUID();

    await jobRepo.createJob(jobId, {
      type: 'CAREER_PATH',
      userId,
      idempotencyKey,
      input: {
        currentTitle: sanitizedCurrentTitle,
        targetTitle: sanitizedTargetTitle,
        currentSkills: sanitizedSkills
      }
    });

    await publishEvent(
      topic,
      EventTypes.CAREER_PATH_REQUESTED,
      {
        userId,
        jobId,
        currentTitle: sanitizedCurrentTitle,
        targetTitle: sanitizedTargetTitle,
        currentSkills: sanitizedSkills
      },
      { userId, jobId }
    );

    logger.info('Career path requested', {
      userId,
      jobId,
      requestId: req.requestId
    });

    return res.status(202).json({
      message: 'Career path analysis queued',
      jobId,
      statusUrl: `/v1/career/result/${jobId}`,
      ...responseMeta(req)
    });
  } catch (error) {
    next(error);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Get Career Path Result
// ─────────────────────────────────────────────────────────────────────────────

export async function getCareerResult(req, res, next) {
  try {
    const userId = req.user?.uid;
    const { jobId } = req.params;

    if (!userId) {
      return res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'User authentication required',
        ...responseMeta(req)
      });
    }

    const job = await jobRepo.findById(jobId);

    if (!job || job.userId !== userId) {
      return res.status(404).json({
        error: 'NOT_FOUND',
        message: 'Job not found',
        ...responseMeta(req)
      });
    }

    if (job.status === 'failed') {
      return res.status(200).json({
        jobId,
        status: 'failed',
        error: job.error || 'Career analysis failed',
        ...responseMeta(req)
      });
    }

    if (job.status !== 'complete') {
      return res.status(202).json({
        jobId,
        status: job.status,
        message: 'Result not yet available',
        ...responseMeta(req)
      });
    }

    return res.status(200).json({
      jobId,
      status: 'complete',
      result: job.result,
      ...responseMeta(req)
    });
  } catch (error) {
    next(error);
  }
}