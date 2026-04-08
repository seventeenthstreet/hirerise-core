import { publishEvent, EventTypes } from '../../../shared/pubsub/index.js';
import { partitionedJobRepo as jobRepo } from '../../../shared/repositories/partitioned-jobs.repository.js';
import { logger } from '../../../shared/logger/index.js';
import { resolveEngine } from '../../../shared/engine-versions/index.js';
import { SalaryBenchmarkEngineV1 } from '../engines/salary-benchmark-v1.engine.js';

const ENGINE_MAP = Object.freeze({
  'salary_bench_v1.2': SalaryBenchmarkEngineV1,
  'salary_bench_v1.1': SalaryBenchmarkEngineV1, // backward-safe alias
});

const ENGINE_VERSION =
  process.env.SALARY_ENGINE_VERSION ?? 'salary_bench_v1.2';

function createEngine(version) {
  const resolved = resolveEngine(version, ENGINE_MAP);

  if (!resolved) {
    const error = new Error(`Unknown salary engine version: ${version}`);
    error.code = 'ENGINE_NOT_FOUND';
    throw error;
  }

  const engine =
    typeof resolved === 'function' ? new resolved() : resolved;

  if (typeof engine?.benchmark !== 'function') {
    const error = new Error(
      `Invalid salary engine: ${version} missing benchmark()`,
    );
    error.code = 'INVALID_ENGINE';
    throw error;
  }

  return engine;
}

async function publishSalaryReadyEvent({
  userId,
  jobId,
  median,
  childLogger,
}) {
  try {
    await publishEvent(
      process.env.PUBSUB_NOTIFICATION_TOPIC,
      EventTypes.NOTIFICATION_REQUESTED,
      {
        userId,
        notificationType: 'SALARY_READY',
        data: {
          jobId,
          salaryMedian: median,
        },
      },
    );
  } catch (err) {
    childLogger.error('Salary notification publish failed', {
      jobId,
      message: err?.message,
      code: err?.code,
      stack: err?.stack,
    });

    // intentionally do not fail completed job
  }
}

export async function handleSalaryBenchmarkRequested(
  envelope,
  message = {},
) {
  const payload = envelope?.payload ?? {};

  const {
    userId,
    jobId,
    jobTitle,
    location,
    yearsExperience,
    industry,
  } = payload;

  const childLogger = logger.child({
    handler: 'handleSalaryBenchmarkRequested',
    userId: userId ?? null,
    jobId: jobId ?? null,
    engineVersion: ENGINE_VERSION,
    deliveryAttempt: message?.deliveryAttempt ?? 1,
    service: process.env.SERVICE_NAME ?? 'salary-worker',
  });

  if (!userId || !jobId) {
    childLogger.error('Invalid payload — missing required fields', {
      hasUserId: Boolean(userId),
      hasJobId: Boolean(jobId),
    });
    return;
  }

  const serviceName =
    process.env.SERVICE_NAME ?? 'salary-worker';

  const { claimed, status } = await jobRepo.claimJob(
    jobId,
    serviceName,
  );

  if (!claimed) {
    childLogger.info('Job already processed or claimed', {
      status,
    });
    return;
  }

  childLogger.info('Processing salary benchmark');

  try {
    const engine = createEngine(ENGINE_VERSION);

    const result = await engine.benchmark({
      jobTitle,
      location,
      yearsExperience,
      industry,
    });

    await jobRepo.completeJob(jobId, result);

    await publishSalaryReadyEvent({
      userId,
      jobId,
      median: result.median,
      childLogger,
    });

    childLogger.info('Salary benchmark complete', {
      median: result.median,
      currency: result.currency,
      engineVersion: result.engineVersion,
    });
  } catch (err) {
    childLogger.error('Salary benchmark failed', {
      message: err?.message,
      code: err?.code,
      stack: err?.stack,
    });

    await jobRepo.failJob(
      jobId,
      err?.code ?? 'SALARY_ERROR',
      err?.message ?? 'Unknown error',
    );

    throw err;
  }
}