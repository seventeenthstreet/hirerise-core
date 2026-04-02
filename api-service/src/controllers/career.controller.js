import { randomUUID } from 'crypto';
import { publishEvent, EventTypes } from '../../../shared/pubsub/index.js';
import { partitionedJobRepo as jobRepo } from '../../../shared/repositories/partitioned-jobs.repository.js';
import { validateCareerPathRequest, sanitizeString } from '../../../shared/validation/index.js';
import { logger } from '../../../shared/logger/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Request Career Path Analysis
// ─────────────────────────────────────────────────────────────────────────────

export async function requestCareerPath(req, res, next) {
  try {
    const userId = req.user.uid;

    // Validate env early
    if (!process.env.PUBSUB_CAREER_TOPIC) {
      throw new Error('Missing PUBSUB_CAREER_TOPIC environment variable');
    }

    const validation = validateCareerPathRequest(req.body);
    if (!validation.valid) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: validation.error,
        requestId: req.requestId,
        timestamp: new Date().toISOString(),
      });
    }

    const { currentTitle, targetTitle, currentSkills = [] } = req.body;

    const jobId = randomUUID();

    // Sanitize inputs ONCE
    const sanitizedCurrentTitle = sanitizeString(currentTitle, 200);
    const sanitizedTargetTitle = sanitizeString(targetTitle, 200);
    const sanitizedSkills = Array.isArray(currentSkills)
      ? currentSkills.slice(0, 50).map(s => sanitizeString(s, 100))
      : [];

    // Stronger idempotency key (short + hashed-like)
    const idempotencyKey = `career_${userId}_${sanitizedCurrentTitle}_${sanitizedTargetTitle}`.slice(0, 200);

    // Create job
    await jobRepo.createJob(jobId, {
      type: 'CAREER_PATH',
      userId,
      idempotencyKey,
      input: {
        currentTitle: sanitizedCurrentTitle,
        targetTitle: sanitizedTargetTitle,
        currentSkills: sanitizedSkills,
      },
    });

    // Publish event with sanitized payload
    await publishEvent(
      process.env.PUBSUB_CAREER_TOPIC,
      EventTypes.CAREER_PATH_REQUESTED,
      {
        userId,
        jobId,
        currentTitle: sanitizedCurrentTitle,
        targetTitle: sanitizedTargetTitle,
        currentSkills: sanitizedSkills,
      },
      { userId, jobId }
    );

    logger.info('Career path requested', {
      userId,
      jobId,
      requestId: req.requestId,
    });

    return res.status(202).json({
      message: 'Career path analysis queued',
      jobId,
      statusUrl: `/v1/career/result/${jobId}`,
      requestId: req.requestId,
      timestamp: new Date().toISOString(),
    });

  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Get Career Path Result
// ─────────────────────────────────────────────────────────────────────────────

export async function getCareerResult(req, res, next) {
  try {
    const userId = req.user.uid;
    const { jobId } = req.params;

    const job = await jobRepo.findById(jobId);

    if (!job || job.userId !== userId) {
      return res.status(404).json({
        error: 'NOT_FOUND',
        message: 'Job not found',
        requestId: req.requestId,
        timestamp: new Date().toISOString(),
      });
    }

    if (job.status !== 'complete') {
      return res.status(202).json({
        status: job.status,
        message: 'Result not yet available',
        requestId: req.requestId,
        timestamp: new Date().toISOString(),
      });
    }

    return res.json({
      jobId,
      result: job.result,
      requestId: req.requestId,
      timestamp: new Date().toISOString(),
    });

  } catch (err) {
    next(err);
  }
}