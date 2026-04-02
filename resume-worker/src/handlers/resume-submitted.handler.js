import { publishEvent, EventTypes } from '../../../shared/pubsub/index.js';
import { ResumeRepository, ScoreRepository } from '../../../shared/repositories/domain.repositories.js';
import { partitionedJobRepo as jobRepo } from '../../../shared/repositories/partitioned-jobs.repository.js';
import { logger } from '../../../shared/logger/index.js';
import { resolveEngine } from '../../../shared/engine-versions/index.js';
import { ResumeScoreEngineV1 } from '../engines/resume-score-v1.engine.js';
import { parseResume } from '../parsers/resume.parser.js';
import { safeValidateEnvelope } from '../validators/envelope.validator.js';
import { claimEvent, releaseEvent } from '../../../shared/deduplication/index.js';
import { ErrorCodes, HireRiseError, RetryStrategy, resolveRetryStrategy } from '../../../shared/errors/index.js';

const ENGINE_MAP = {
  'resume_score_v1.0': ResumeScoreEngineV1,
};

const resumeRepo = new ResumeRepository();
const scoreRepo  = new ScoreRepository();

const ENGINE_VERSION = process.env.RESUME_ENGINE_VERSION ?? 'resume_score_v1.0';

export async function handleResumeSubmitted(envelope, message = {}) {

  const childLogger = logger.child({
    handler: 'handleResumeSubmitted.v2',
    pubsubMessageId: message?.id,
    deliveryAttempt: message?.deliveryAttempt ?? 1,
  });

  // 1️⃣ Validate Envelope
  const validated = safeValidateEnvelope(envelope, EventTypes.RESUME_SUBMITTED);
  if (!validated) {
    childLogger.error('Invalid event — discarded');
    return;
  }

  const { payload } = validated;
  const { userId, resumeId, jobId, resumeStoragePath, mimeType } = payload;
  const eventId = envelope.eventId;

  const log = childLogger.child({
    userId,
    resumeId,
    jobId,
    engineVersion: ENGINE_VERSION,
  });

  // 2️⃣ Deduplication
  const { claimed } = await claimEvent(eventId, { userId, resumeId, jobId });
  if (!claimed) {
    log.info('Duplicate event skipped');
    return;
  }

  // 3️⃣ Job Claim (Replace backend with Supabase internally)
  const { claimed: jobClaimed, status } =
    await jobRepo.claimJob(jobId, process.env.SERVICE_NAME);

  if (!jobClaimed) {
    log.info('Job already claimed', { status });
    return;
  }

  log.info('Processing resume');

  try {
    await resumeRepo.markProcessing(resumeId);

    // 4️⃣ Parse Resume
    let parsed;
    try {
      parsed = await parseResume(resumeStoragePath, mimeType);
    } catch (err) {
      throw new HireRiseError(
        err.code === 'ENOENT' || err.code === '404'
          ? ErrorCodes.STORAGE_NOT_FOUND
          : ErrorCodes.STORAGE_READ_FAILED,
        `Resume read failed: ${err.message}`,
        { resumeStoragePath }
      );
    }

    log.info('Parsed resume', {
      sections: Object.keys(parsed?.sections ?? {}).length,
      skills: parsed?.skills?.length ?? 0,
    });

    // 5️⃣ Score
    let scoreResult;
    try {
      const engine = resolveEngine(ENGINE_VERSION, ENGINE_MAP);
      scoreResult = engine.score(parsed);
    } catch (err) {
      throw new HireRiseError(
        ErrorCodes.SCORE_COMPUTATION_FAILED,
        `Scoring failed: ${err.message}`
      );
    }

    log.info('Scored resume', {
      score: scoreResult.overallScore,
      tier: scoreResult.tier,
    });

    // 6️⃣ Persist
    await scoreRepo.upsertScore(userId, resumeId, ENGINE_VERSION, {
      overallScore: scoreResult.overallScore,
      tier: scoreResult.tier,
      breakdown: scoreResult.breakdown,
      extractedSkills: scoreResult.extractedSkills,
      recommendations: scoreResult.recommendations,
    });

    await resumeRepo.markComplete(resumeId, ENGINE_VERSION);

    await jobRepo.completeJob(jobId, {
      overallScore: scoreResult.overallScore,
    });

    // 7️⃣ Events
    await publishEvent(
      process.env.PUBSUB_SCORE_UPDATED_TOPIC,
      EventTypes.SCORE_UPDATED,
      { userId, resumeId, overallScore: scoreResult.overallScore, engineVersion: ENGINE_VERSION },
    );

    await publishEvent(
      process.env.PUBSUB_NOTIFICATION_TOPIC,
      EventTypes.NOTIFICATION_REQUESTED,
      {
        userId,
        notificationType: 'RESUME_SCORED',
        data: {
          resumeId,
          overallScore: scoreResult.overallScore,
          tier: scoreResult.tier,
        },
      },
    );

    log.info('Pipeline complete');

  } catch (err) {

    const strategy = resolveRetryStrategy(err);

    const logData = err instanceof HireRiseError
      ? err.toLog()
      : {
          errorCode: ErrorCodes.INTERNAL_ERROR,
          errorMessage: err.message,
        };

    log.error('Processing failed', {
      ...logData,
      retryStrategy: strategy,
    });

    await jobRepo.failJob(jobId, logData.errorCode, err.message);
    await resumeRepo.markFailed(resumeId, logData.errorCode);

    if (strategy === RetryStrategy.RELEASE) {
      await releaseEvent(eventId);
    }

    if (strategy === RetryStrategy.NO_RETRY || (message?.deliveryAttempt ?? 1) >= 5) {
      await publishEvent(
        process.env.PUBSUB_NOTIFICATION_TOPIC,
        EventTypes.NOTIFICATION_REQUESTED,
        {
          userId,
          notificationType: 'JOB_FAILED',
          data: { jobId, resumeId, errorCode: logData.errorCode },
        },
      ).catch(() => {});
    }

    throw err;
  }
}