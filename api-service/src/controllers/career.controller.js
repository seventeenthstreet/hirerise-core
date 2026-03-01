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

    const validation = validateCareerPathRequest(req.body);
    if (!validation.valid) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: validation.error,
      });
    }

    const { currentTitle, targetTitle, currentSkills = [] } = req.body;
    const jobId = randomUUID();

    // Create sharded automation job
    await jobRepo.createJob(jobId, {
      type: 'CAREER_PATH',
      userId,
      idempotencyKey: `career_${userId}_${sanitizeString(currentTitle, 100)}_${sanitizeString(targetTitle, 100)}`,
      input: {
        currentTitle: sanitizeString(currentTitle, 200),
        targetTitle: sanitizeString(targetTitle, 200),
        currentSkills: Array.isArray(currentSkills)
          ? currentSkills.slice(0, 50).map(s => sanitizeString(s, 100))
          : [],
      },
    });

    // Publish event
    await publishEvent(
      process.env.PUBSUB_CAREER_TOPIC,
      EventTypes.CAREER_PATH_REQUESTED,
      { userId, jobId, currentTitle, targetTitle, currentSkills },
      { userId, jobId }
    );

    logger.info('Career path requested', {
      userId,
      jobId,
      requestId: req.requestId,
    });

    res.status(202).json({
      message: 'Career path analysis queued',
      jobId,
      statusUrl: `/v1/career/result/${jobId}`,
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
      });
    }

    if (job.status !== 'complete') {
      return res.status(202).json({
        status: job.status,
        message: 'Result not yet available',
      });
    }

    res.json({ jobId, result: job.result });

  } catch (err) {
    next(err);
  }
}