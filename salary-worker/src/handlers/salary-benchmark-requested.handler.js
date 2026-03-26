import { publishEvent, EventTypes } from '../../../shared/pubsub/index.js';
import { partitionedJobRepo as jobRepo } from '../../../shared/repositories/partitioned-jobs.repository.js';
import { logger } from '../../../shared/logger/index.js';
import { resolveEngine } from '../../../shared/engine-versions/index.js';
import { SalaryBenchmarkEngineV1 } from '../engines/salary-benchmark-v1.engine.js';

const ENGINE_MAP = {
  'salary_bench_v1.0': SalaryBenchmarkEngineV1,
};

const ENGINE_VERSION =
  process.env.SALARY_ENGINE_VERSION ?? 'salary_bench_v1.0';

export async function handleSalaryBenchmarkRequested(envelope, message) {

  const { payload } = envelope;
  const { userId, jobId, jobTitle, location, yearsExperience, industry } = payload;

  const childLogger = logger.child({
    handler: 'handleSalaryBenchmarkRequested',
    userId,
    jobId,
    engineVersion: ENGINE_VERSION,
    deliveryAttempt: message.deliveryAttempt,
  });

  // ─────────────────────────────────────────────────────────────
  // Claim Job (Sharded Repository)
  // ─────────────────────────────────────────────────────────────

  const { claimed, status } =
    await jobRepo.claimJob(jobId, process.env.SERVICE_NAME);

  if (!claimed) {
    childLogger.info('Job already processed or claimed', { status });
    return;
  }

  childLogger.info('Processing salary benchmark');

  try {

    const engine = resolveEngine(ENGINE_VERSION, ENGINE_MAP);

    const result = await engine.benchmark({
      jobTitle,
      location,
      yearsExperience,
      industry,
    });

    // ─────────────────────────────────────────────────────────
    // Persist Job Result
    // ─────────────────────────────────────────────────────────

    await jobRepo.completeJob(jobId, result);

    // ─────────────────────────────────────────────────────────
    // Emit Notification Event
    // ─────────────────────────────────────────────────────────

    await publishEvent(
      process.env.PUBSUB_NOTIFICATION_TOPIC,
      EventTypes.NOTIFICATION_REQUESTED,
      {
        userId,
        notificationType: 'SALARY_READY',
        data: {
          jobId,
          salaryMedian: result.median,
        },
      },
    );

    childLogger.info('Salary benchmark complete', {
      median: result.median,
    });

  } catch (err) {

    childLogger.error('Salary benchmark failed', { err });

    await jobRepo.failJob(
      jobId,
      err.code ?? 'SALARY_ERROR',
      err.message,
    );

    throw err; // nack for retry/DLQ
  }
}