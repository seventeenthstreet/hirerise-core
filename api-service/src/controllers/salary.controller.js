import { randomUUID } from 'crypto';
import { publishEvent, EventTypes } from '../../../shared/pubsub/index.js';
import { partitionedJobRepo as jobRepo } from '../../../shared/repositories/partitioned-jobs.repository.js';
import { validateSalaryRequest, sanitizeString } from '../../../shared/validation/index.js';
import { logger } from '../../../shared/logger/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Request Salary Benchmark
// ─────────────────────────────────────────────────────────────────────────────

export async function requestSalaryBenchmark(req, res, next) {
  try {
    const userId = req.user.uid;

    // Validate env early
    if (!process.env.PUBSUB_SALARY_TOPIC) {
      throw new Error('Missing PUBSUB_SALARY_TOPIC environment variable');
    }

    const validation = validateSalaryRequest(req.body);
    if (!validation.valid) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: validation.error,
        requestId: req.requestId,
        timestamp: new Date().toISOString(),
      });
    }

    const { jobTitle, location, yearsExperience, industry } = req.body;

    const jobId = randomUUID();

    // Sanitize inputs ONCE
    const sanitizedJobTitle = sanitizeString(jobTitle, 200);
    const sanitizedLocation = sanitizeString(location, 200);
    const sanitizedIndustry = industry ? sanitizeString(industry, 100) : null;

    // Harden numeric input
    const safeYearsExperience = Math.max(0, Math.min(Number(yearsExperience) || 0, 50));

    // Stronger + bounded idempotency key
    const idempotencyKey = `salary_${userId}_${sanitizedJobTitle}_${sanitizedLocation}_${safeYearsExperience}`.slice(0, 200);

    // Create job
    await jobRepo.createJob(jobId, {
      type: 'SALARY_BENCHMARK',
      userId,
      idempotencyKey,
      input: {
        jobTitle: sanitizedJobTitle,
        location: sanitizedLocation,
        yearsExperience: safeYearsExperience,
        industry: sanitizedIndustry,
      },
    });

    // Publish event (sanitized payload)
    await publishEvent(
      process.env.PUBSUB_SALARY_TOPIC,
      EventTypes.SALARY_BENCHMARK_REQUESTED,
      {
        userId,
        jobId,
        jobTitle: sanitizedJobTitle,
        location: sanitizedLocation,
        yearsExperience: safeYearsExperience,
        industry: sanitizedIndustry,
      },
      { userId, jobId }
    );

    logger.info('Salary benchmark requested', {
      userId,
      jobId,
      requestId: req.requestId,
    });

    return res.status(202).json({
      message: 'Salary benchmark queued',
      jobId,
      statusUrl: `/v1/salary/result/${jobId}`,
      requestId: req.requestId,
      timestamp: new Date().toISOString(),
    });

  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Get Salary Result
// ─────────────────────────────────────────────────────────────────────────────

export async function getSalaryResult(req, res, next) {
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