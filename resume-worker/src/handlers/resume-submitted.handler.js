import { publishEvent, EventTypes } from '../../../shared/pubsub/index.js';
import {
  ResumeRepository,
  ScoreRepository,
} from '../../../shared/repositories/domain.repositories.js';
import {
  partitionedJobRepo as jobRepo,
} from '../../../shared/repositories/partitioned-jobs.repository.js';
import { logger } from '../../../shared/logger/index.js';
import { resolveEngine } from '../../../shared/engine-versions/index.js';
import { ResumeScoreEngineV1 } from '../engines/resume-score-v1.engine.js';
import { parseResume } from '../parsers/resume.parser.js';
import { safeValidateEnvelope } from '../validators/envelope.validator.js';
import {
  claimEvent,
  releaseEvent,
} from '../../../shared/deduplication/index.js';
import {
  ErrorCodes,
  HireRiseError,
  RetryStrategy,
  resolveRetryStrategy,
} from '../../../shared/errors/index.js';

const ENGINE_MAP = Object.freeze({
  'resume_score_v1.0': ResumeScoreEngineV1,
  'resume_score_v1.1': ResumeScoreEngineV1,
});

const resumeRepo = new ResumeRepository();
const scoreRepo = new ScoreRepository();

const ENGINE_VERSION =
  process.env.RESUME_ENGINE_VERSION ?? 'resume_score_v1.1';

const MAX_DELIVERY_ATTEMPTS = 5;

export async function handleResumeSubmitted(envelope, message = {}) {
  const deliveryAttempt = Number(message?.deliveryAttempt ?? 1);

  const baseLogger = logger.child({
    handler: 'handleResumeSubmitted.v3',
    pubsubMessageId: message?.id ?? null,
    deliveryAttempt,
  });

  const validated = safeValidateEnvelope(
    envelope,
    EventTypes.RESUME_SUBMITTED
  );

  if (!validated) {
    baseLogger.error('Invalid event envelope discarded');
    return;
  }

  const { payload, eventId } = validated;
  const {
    userId,
    resumeId,
    jobId,
    resumeStoragePath,
    mimeType,
  } = payload;

  const log = baseLogger.child({
    userId,
    resumeId,
    jobId,
    engineVersion: ENGINE_VERSION,
    eventId,
  });

  let eventClaimed = false;

  try {
    const eventClaim = await claimEvent(eventId, {
      userId,
      resumeId,
      jobId,
    });

    if (!eventClaim?.claimed) {
      log.info('Duplicate event skipped');
      return;
    }

    eventClaimed = true;

    const jobClaim = await jobRepo.claimJob(
      jobId,
      process.env.SERVICE_NAME
    );

    if (!jobClaim?.claimed) {
      log.info('Job already claimed', {
        status: jobClaim?.status ?? 'unknown',
      });

      await releaseEvent(eventId);
      return;
    }

    log.info('Processing resume started');

    await resumeRepo.markProcessing(resumeId);

    let parsed;

    try {
      parsed = await parseResume(resumeStoragePath, mimeType);
    } catch (err) {
      throw new HireRiseError(
        err?.code === 'ENOENT' || err?.code === '404'
          ? ErrorCodes.STORAGE_NOT_FOUND
          : ErrorCodes.STORAGE_READ_FAILED,
        `Resume read failed: ${err.message}`,
        { resumeStoragePath }
      );
    }

    log.info('Resume parsed successfully', {
      sectionCount: Object.keys(parsed?.sections ?? {}).length,
      skillCount: parsed?.skills?.length ?? 0,
    });

    let scoreResult;

    try {
      const EngineClass = resolveEngine(
        ENGINE_VERSION,
        ENGINE_MAP
      );

      const engine =
        typeof EngineClass === 'function'
          ? new EngineClass()
          : EngineClass;

      scoreResult = engine.score(parsed);
    } catch (err) {
      throw new HireRiseError(
        ErrorCodes.SCORE_COMPUTATION_FAILED,
        `Scoring failed: ${err.message}`
      );
    }

    log.info('Resume scored successfully', {
      overallScore: scoreResult.overallScore,
      tier: scoreResult.tier,
    });

    await Promise.all([
      scoreRepo.upsertScore(
        userId,
        resumeId,
        ENGINE_VERSION,
        {
          overallScore: scoreResult.overallScore,
          tier: scoreResult.tier,
          breakdown: scoreResult.breakdown,
          extractedSkills: scoreResult.extractedSkills,
          recommendations: scoreResult.recommendations,
        }
      ),
      resumeRepo.markComplete(resumeId, ENGINE_VERSION),
      jobRepo.completeJob(jobId, {
        overallScore: scoreResult.overallScore,
      }),
    ]);

    await Promise.all([
      publishEvent(
        process.env.PUBSUB_SCORE_UPDATED_TOPIC,
        EventTypes.SCORE_UPDATED,
        {
          userId,
          resumeId,
          overallScore: scoreResult.overallScore,
          engineVersion: ENGINE_VERSION,
        }
      ),
      publishEvent(
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
        }
      ),
    ]);

    log.info('Resume processing pipeline completed');
  } catch (err) {
    const retryStrategy = resolveRetryStrategy(err);

    const logData =
      err instanceof HireRiseError
        ? err.toLog()
        : {
            errorCode: ErrorCodes.INTERNAL_ERROR,
            errorMessage: err?.message ?? 'Unknown error',
          };

    log.error('Resume processing failed', {
      ...logData,
      retryStrategy,
    });

    await Promise.allSettled([
      jobRepo.failJob(
        jobId,
        logData.errorCode,
        logData.errorMessage
      ),
      resumeRepo.markFailed(resumeId, logData.errorCode),
    ]);

    if (
      retryStrategy === RetryStrategy.RELEASE &&
      eventClaimed
    ) {
      await releaseEvent(eventId).catch((releaseErr) => {
        log.error('Failed to release dedup event', {
          error: releaseErr.message,
        });
      });
    }

    if (
      retryStrategy === RetryStrategy.NO_RETRY ||
      deliveryAttempt >= MAX_DELIVERY_ATTEMPTS
    ) {
      await publishEvent(
        process.env.PUBSUB_NOTIFICATION_TOPIC,
        EventTypes.NOTIFICATION_REQUESTED,
        {
          userId,
          notificationType: 'JOB_FAILED',
          data: {
            jobId,
            resumeId,
            errorCode: logData.errorCode,
          },
        }
      ).catch((notifyErr) => {
        log.error('Failure notification publish failed', {
          error: notifyErr.message,
        });
      });
    }

    throw err;
  }
}