'use strict';

/**
 * PATCH — resume-worker/src/handlers/resume-submitted.handler.js
 *
 * DROP-IN REPLACEMENT for the parseResume + score pipeline.
 *
 * CHANGES vs existing handler:
 *  1. After parseResume(), normalize to HireRiseResume schema
 *  2. Pass normalized schema to ResumeScoreEngineV2
 *  3. Store structured_resume in the score row
 *  4. Falls back to v1 engine automatically if v2 not in ENGINE_MAP
 */

import { publishEvent, EventTypes } from '../../../shared/pubsub/index.js';
import {
  ResumeRepository,
  ScoreRepository,
} from '../../../shared/repositories/domain.repositories.js';
import { partitionedJobRepo as jobRepo } from '../../../shared/repositories/partitioned-jobs.repository.js';
import { logger } from '../../../shared/logger/index.js';
import { resolveEngine } from '../../../shared/engine-versions/index.js';
import { ResumeScoreEngineV1 } from '../engines/resume-score-v1.engine.js';
import { ResumeScoreEngineV2 } from '../engines/resume-score-v2.engine.js';
// FIX: was '../parsers/resume.parser.js' — that directory does not exist.
// The actual file is at '../services/resume.parser.js'.
import { parseResume } from '../services/resume.parser.js';
import { safeValidateEnvelope } from '../validators/envelope.validator.js';
import { claimEvent, releaseEvent } from '../../../shared/deduplication/index.js';
import {
  ErrorCodes,
  HireRiseError,
  RetryStrategy,
  resolveRetryStrategy,
} from '../../../shared/errors/index.js';

// ── NEW import ────────────────────────────────────────────────────────────────
import { normalizeFromParsed } from '../../../services/resumeParser/resume.normalizer.js';

const ENGINE_MAP = Object.freeze({
  'resume_score_v1.0': ResumeScoreEngineV1,
  'resume_score_v1.1': ResumeScoreEngineV1,
  'resume_score_v2.0': ResumeScoreEngineV2,
});

const resumeRepo = new ResumeRepository();
const scoreRepo  = new ScoreRepository();

const ENGINE_VERSION =
  process.env.RESUME_ENGINE_VERSION ?? 'resume_score_v2.0';

const MAX_DELIVERY_ATTEMPTS = 5;

export async function handleResumeSubmitted(envelope, message = {}) {
  const deliveryAttempt = Number(message?.deliveryAttempt ?? 1);

  const baseLogger = logger.child({
    handler:         'handleResumeSubmitted.v4',
    pubsubMessageId: message?.id ?? null,
    deliveryAttempt,
  });

  const validated = safeValidateEnvelope(envelope, EventTypes.RESUME_SUBMITTED);
  if (!validated) {
    baseLogger.error('Invalid event envelope discarded');
    return;
  }

  const { payload, eventId } = validated;
  const { userId, resumeId, jobId, resumeStoragePath, mimeType } = payload;

  const log = baseLogger.child({
    userId,
    resumeId,
    jobId,
    engineVersion: ENGINE_VERSION,
    eventId,
  });

  let eventClaimed = false;

  try {
    const eventClaim = await claimEvent(eventId, { userId, resumeId, jobId });
    if (!eventClaim?.claimed) {
      log.info('Duplicate event skipped');
      return;
    }
    eventClaimed = true;

    const jobClaim = await jobRepo.claimJob(jobId, process.env.SERVICE_NAME);
    if (!jobClaim?.claimed) {
      log.info('Job already claimed', { status: jobClaim?.status ?? 'unknown' });
      await releaseEvent(eventId);
      return;
    }

    log.info('Processing resume started');
    await resumeRepo.markProcessing(resumeId);

    // ── Step 1: Raw parse ──────────────────────────────────────────────────
    let rawParsed;
    try {
      rawParsed = await parseResume(resumeStoragePath, mimeType);
    } catch (err) {
      throw new HireRiseError(
        err?.code === 'ENOENT' || err?.code === '404'
          ? ErrorCodes.STORAGE_NOT_FOUND
          : ErrorCodes.STORAGE_READ_FAILED,
        `Resume read failed: ${err.message}`,
        { resumeStoragePath }
      );
    }

    log.info('Resume parsed (raw)', {
      sectionCount: Object.keys(rawParsed?.sections ?? {}).length,
      skillCount:   rawParsed?.skills?.length ?? 0,
    });

    // ── Step 2: Normalize to HireRise schema ──────────────────────────────
    //
    // parseResume() returns the old rawText/sections/skills shape.
    // We need to bridge it to the structured schema.
    //
    // The resume-worker parser is different from the onboarding parser —
    // it returns { rawText, sections, skills, metadata }.
    // We build a minimal parsed object that normalizeFromParsed() can accept.
    let structuredResume = null;

    try {
      // Bridge old resume-worker parser output to the shared normalizer
      const bridgedParsed = {
        name:                null,  // not extracted by resume-worker parser
        email:               null,
        phone:               null,
        location:            { city: null, country: null },
        skills:              rawParsed?.skills ?? [],
        detectedRoles:       [],
        yearsExperience:     rawParsed?.metadata?.totalYearsExperience ?? null,
        education:           rawParsed?.sections?.education ?? [],
        experience:          rawParsed?.sections?.experience ?? [],
        certifications:      rawParsed?.sections?.certifications ?? [],
        professionalSummary: (rawParsed?.sections?.summary ?? []).join(' ') || null,
        industry:            null,
        educationLevel:      null,
        confidenceScore:     0,    // will be recomputed
        needsAIParsing:      false,
        parserVersion:       '2.0.0',
        parsedAt:            new Date().toISOString(),
      };

      structuredResume = normalizeFromParsed(bridgedParsed, resumeId, userId);

      log.info('Resume normalized to HireRise schema', {
        completenessScore: structuredResume.metadata.completenessScore,
        skillCount:        structuredResume.skills.length,
        experienceCount:   structuredResume.experience.length,
        educationCount:    structuredResume.education.length,
        domain:            structuredResume.metadata.detectedDomain,
      });
    } catch (normErr) {
      // Normalization failure is non-fatal for the scoring pipeline
      log.warn('Schema normalization failed (non-fatal, proceeding with raw parsed)', {
        error: normErr?.message,
      });
    }

    // ── Step 3: Score ─────────────────────────────────────────────────────
    let scoreResult;
    try {
      const EngineClass = resolveEngine(ENGINE_VERSION, ENGINE_MAP);
      const engine = typeof EngineClass === 'function' ? new EngineClass() : EngineClass;

      // v2 engine accepts structuredResume; v1 accepts rawParsed
      const scoreInput = engine instanceof ResumeScoreEngineV2 && structuredResume
        ? structuredResume
        : rawParsed;

      scoreResult = engine.score(scoreInput);
    } catch (err) {
      throw new HireRiseError(
        ErrorCodes.SCORE_COMPUTATION_FAILED,
        `Scoring failed: ${err.message}`
      );
    }

    log.info('Resume scored', {
      overallScore: scoreResult.overallScore,
      tier:         scoreResult.tier,
    });

    // ── Step 4: Persist ───────────────────────────────────────────────────
    await Promise.all([
      scoreRepo.upsertScore(userId, resumeId, ENGINE_VERSION, {
        overallScore:     scoreResult.overallScore,
        tier:             scoreResult.tier,
        breakdown:        scoreResult.breakdown,
        extractedSkills:  scoreResult.extractedSkills,
        recommendations:  scoreResult.recommendations,
        // Store the structured schema alongside the score
        structuredResume: structuredResume ?? null,
      }),
      resumeRepo.markComplete(resumeId, ENGINE_VERSION),
      jobRepo.completeJob(jobId, { overallScore: scoreResult.overallScore }),
    ]);

    // ── Step 5: Publish events ────────────────────────────────────────────
    await Promise.all([
      publishEvent(
        process.env.PUBSUB_SCORE_UPDATED_TOPIC,
        EventTypes.SCORE_UPDATED,
        {
          userId,
          resumeId,
          overallScore:  scoreResult.overallScore,
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
            tier:         scoreResult.tier,
          },
        }
      ),
    ]);

    log.info('Resume processing pipeline completed');

  } catch (err) {
    const retryStrategy = resolveRetryStrategy(err);
    const logData = err instanceof HireRiseError
      ? err.toLog()
      : { errorCode: ErrorCodes.INTERNAL_ERROR, errorMessage: err?.message ?? 'Unknown error' };

    log.error('Resume processing failed', { ...logData, retryStrategy });

    await Promise.allSettled([
      jobRepo.failJob(jobId, logData.errorCode, logData.errorMessage),
      resumeRepo.markFailed(resumeId, logData.errorCode),
    ]);

    if (retryStrategy === RetryStrategy.RELEASE && eventClaimed) {
      await releaseEvent(eventId).catch(releaseErr => {
        log.error('Failed to release dedup event', { error: releaseErr.message });
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
          data: { jobId, resumeId, errorCode: logData.errorCode },
        }
      ).catch(notifyErr => {
        log.error('Failure notification publish failed', { error: notifyErr.message });
      });
    }

    throw err;
  }
}