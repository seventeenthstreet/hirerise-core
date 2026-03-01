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

    const validation = validateSalaryRequest(req.body);
    if (!validation.valid) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: validation.error,
      });
    }

    const { jobTitle, location, yearsExperience, industry } = req.body;
    const jobId = randomUUID();

    // Create sharded automation job
    await jobRepo.createJob(jobId, {
      type: 'SALARY_BENCHMARK',
      userId,
      idempotencyKey: `salary_${userId}_${sanitizeString(jobTitle, 100)}_${sanitizeString(location, 100)}`,
      input: {
        jobTitle: sanitizeString(jobTitle, 200),
        location: sanitizeString(location, 200),
        yearsExperience,
        industry: industry ? sanitizeString(industry, 100) : null,
      },
    });

    // Publish event
    await publishEvent(
      process.env.PUBSUB_SALARY_TOPIC,
      EventTypes.SALARY_BENCHMARK_REQUESTED,
      { userId, jobId, jobTitle, location, yearsExperience, industry },
      { userId, jobId }
    );

    logger.info('Salary benchmark requested', {
      userId,
      jobId,
      requestId: req.requestId,
    });

    res.status(202).json({
      message: 'Salary benchmark queued',
      jobId,
      statusUrl: `/v1/salary/result/${jobId}`,
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