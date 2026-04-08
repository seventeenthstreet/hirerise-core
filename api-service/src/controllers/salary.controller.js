import { createHash, randomUUID } from 'crypto';
import { publishEvent, EventTypes } from '../../../shared/pubsub/index.js';
import { partitionedJobRepo as jobRepo } from '../../../shared/repositories/partitioned-jobs.repository.js';
import {
  validateSalaryRequest,
  sanitizeString
} from '../../../shared/validation/index.js';
import { logger } from '../../../shared/logger/index.js';

const MAX_TITLE_LENGTH = 200;
const MAX_LOCATION_LENGTH = 200;
const MAX_INDUSTRY_LENGTH = 100;
const MAX_EXPERIENCE_YEARS = 50;

function responseMeta(req) {
  return {
    requestId: req.requestId,
    timestamp: new Date().toISOString()
  };
}

function buildIdempotencyKey(
  userId,
  jobTitle,
  location,
  yearsExperience,
  industry
) {
  return createHash('sha256')
    .update(
      `${userId}:${jobTitle}:${location}:${yearsExperience}:${industry || ''}`
    )
    .digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// Request Salary Benchmark
// ─────────────────────────────────────────────────────────────────────────────

export async function requestSalaryBenchmark(req, res, next) {
  try {
    const userId = req.user?.uid;

    if (!userId) {
      return res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'User authentication required',
        ...responseMeta(req)
      });
    }

    const topic = process.env.PUBSUB_SALARY_TOPIC;
    if (!topic) {
      throw new Error('Missing PUBSUB_SALARY_TOPIC environment variable');
    }

    const validation = validateSalaryRequest(req.body);
    if (!validation.valid) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: validation.error,
        ...responseMeta(req)
      });
    }

    const { jobTitle, location, yearsExperience, industry } = req.body;

    const sanitizedJobTitle = sanitizeString(
      jobTitle,
      MAX_TITLE_LENGTH
    );
    const sanitizedLocation = sanitizeString(
      location,
      MAX_LOCATION_LENGTH
    );
    const sanitizedIndustry = industry
      ? sanitizeString(industry, MAX_INDUSTRY_LENGTH)
      : null;

    const safeYearsExperience = Math.max(
      0,
      Math.min(Number(yearsExperience) || 0, MAX_EXPERIENCE_YEARS)
    );

    const idempotencyKey = buildIdempotencyKey(
      userId,
      sanitizedJobTitle,
      sanitizedLocation,
      safeYearsExperience,
      sanitizedIndustry
    );

    const existingJob = await jobRepo.findByIdempotencyKey?.(
      userId,
      idempotencyKey
    );

    if (existingJob) {
      logger.info('Salary benchmark duplicate request reused', {
        userId,
        jobId: existingJob.id,
        requestId: req.requestId
      });

      return res.status(202).json({
        message: 'Salary benchmark already queued',
        jobId: existingJob.id,
        statusUrl: `/v1/salary/result/${existingJob.id}`,
        ...responseMeta(req)
      });
    }

    const jobId = randomUUID();

    await jobRepo.createJob(jobId, {
      type: 'SALARY_BENCHMARK',
      userId,
      idempotencyKey,
      input: {
        jobTitle: sanitizedJobTitle,
        location: sanitizedLocation,
        yearsExperience: safeYearsExperience,
        industry: sanitizedIndustry
      }
    });

    await publishEvent(
      topic,
      EventTypes.SALARY_BENCHMARK_REQUESTED,
      {
        userId,
        jobId,
        jobTitle: sanitizedJobTitle,
        location: sanitizedLocation,
        yearsExperience: safeYearsExperience,
        industry: sanitizedIndustry
      },
      { userId, jobId }
    );

    logger.info('Salary benchmark requested', {
      userId,
      jobId,
      requestId: req.requestId
    });

    return res.status(202).json({
      message: 'Salary benchmark queued',
      jobId,
      statusUrl: `/v1/salary/result/${jobId}`,
      ...responseMeta(req)
    });
  } catch (error) {
    next(error);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Get Salary Result
// ─────────────────────────────────────────────────────────────────────────────

export async function getSalaryResult(req, res, next) {
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
        error: job.error || 'Salary benchmark failed',
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