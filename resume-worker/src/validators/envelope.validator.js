/**
 * resume-worker/src/validators/envelope.validator.js
 *
 * Worker-level schema validation with forward-compatible payload stripping.
 * Permanent schema violations return null in safe mode.
 */

import { z } from 'zod';
import {
  EventTypes,
  SchemaVersions,
} from '../../../shared/events/index.js';
import {
  ErrorCodes,
  HireRiseError,
} from '../../../shared/errors/index.js';
import { logger } from '../../../shared/logger/index.js';

/* ──────────────────────────────────────────────────────────────────────────
 * Helpers
 * ─────────────────────────────────────────────────────────────────────── */

function formatIssues(error) {
  return error.issues.map(
    (issue) => `${issue.path.join('.')}: ${issue.message}`
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * Payload Schemas
 * ─────────────────────────────────────────────────────────────────────── */

const ResumeSubmittedPayloadSchema = z
  .object({
    userId: z.string().uuid(),
    resumeId: z.string().uuid(),
    jobId: z.string().uuid(),
    resumeStoragePath: z.string().min(1).max(1024),
    mimeType: z.enum([
      'application/pdf',
      'text/plain',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ]),
  })
  .strip();

const SalaryBenchmarkRequestedPayloadSchema = z
  .object({
    userId: z.string().uuid(),
    jobId: z.string().uuid(),
    jobTitle: z.string().min(1).max(200),
    location: z.string().min(1).max(200),
    yearsExperience: z.number().min(0).max(60),
    industry: z.string().max(100).optional().nullable(),
  })
  .strip();

const CareerPathRequestedPayloadSchema = z
  .object({
    userId: z.string().uuid(),
    jobId: z.string().uuid(),
    currentTitle: z.string().min(1).max(200),
    targetTitle: z.string().min(1).max(200),
    currentSkills: z
      .array(z.string().max(100))
      .max(50)
      .optional()
      .default([]),
  })
  .strip();

const NotificationRequestedPayloadSchema = z
  .object({
    userId: z.string().uuid(),
    notificationType: z.string().min(1).max(100),
    data: z.record(z.unknown()).optional().default({}),
  })
  .strip();

/* ──────────────────────────────────────────────────────────────────────────
 * Registry
 * ─────────────────────────────────────────────────────────────────────── */

const PAYLOAD_SCHEMAS = Object.freeze({
  [EventTypes.RESUME_SUBMITTED]:
    ResumeSubmittedPayloadSchema,
  [EventTypes.SALARY_BENCHMARK_REQUESTED]:
    SalaryBenchmarkRequestedPayloadSchema,
  [EventTypes.CAREER_PATH_REQUESTED]:
    CareerPathRequestedPayloadSchema,
  [EventTypes.NOTIFICATION_REQUESTED]:
    NotificationRequestedPayloadSchema,
});

/* ──────────────────────────────────────────────────────────────────────────
 * Base Envelope
 * ─────────────────────────────────────────────────────────────────────── */

const BaseEnvelopeSchema = z
  .object({
    eventId: z.string().uuid(),
    eventType: z.nativeEnum(EventTypes),
    schemaVersion: z.string().regex(/^\d+\.\d+$/),
    publishedAt: z.string().datetime(),
    source: z.string().min(1).max(100),
    payload: z.record(z.unknown()),
  })
  .strip();

/* ──────────────────────────────────────────────────────────────────────────
 * Validation Entry Point
 * ─────────────────────────────────────────────────────────────────────── */

export function validateAndParseEnvelope(
  raw,
  expectedEventType
) {
  const envelopeResult = BaseEnvelopeSchema.safeParse(raw);

  if (!envelopeResult.success) {
    const issues = formatIssues(envelopeResult.error);

    throw new HireRiseError(
      ErrorCodes.INVALID_ENVELOPE,
      `Envelope validation failed: ${issues.join('; ')}`,
      { issues }
    );
  }

  const envelope = envelopeResult.data;

  if (envelope.eventType !== expectedEventType) {
    throw new HireRiseError(
      ErrorCodes.UNKNOWN_EVENT_TYPE,
      `Unexpected eventType: ${envelope.eventType}, expected: ${expectedEventType}`,
      {
        received: envelope.eventType,
        expected: expectedEventType,
      }
    );
  }

  const expectedVersion =
    SchemaVersions[envelope.eventType];

  if (expectedVersion) {
    const [incomingMajor] = envelope.schemaVersion
      .split('.')
      .map(Number);

    const [expectedMajor] = expectedVersion
      .split('.')
      .map(Number);

    if (incomingMajor !== expectedMajor) {
      throw new HireRiseError(
        ErrorCodes.SCHEMA_VERSION_MISMATCH,
        `Breaking schema change detected for ${envelope.eventType}: expected major v${expectedMajor}, got v${incomingMajor}`,
        {
          received: envelope.schemaVersion,
          expected: expectedVersion,
        }
      );
    }
  }

  const payloadSchema =
    PAYLOAD_SCHEMAS[envelope.eventType];

  let payload = envelope.payload;

  if (payloadSchema) {
    const payloadResult =
      payloadSchema.safeParse(envelope.payload);

    if (!payloadResult.success) {
      const issues = formatIssues(payloadResult.error);

      throw new HireRiseError(
        ErrorCodes.INVALID_PAYLOAD,
        `Payload validation failed for ${envelope.eventType}: ${issues.join(
          '; '
        )}`,
        {
          issues,
          eventType: envelope.eventType,
        }
      );
    }

    payload = payloadResult.data;
  } else {
    logger.warn('No payload schema registered', {
      eventType: envelope.eventType,
    });
  }

  return {
    ...envelope,
    payload,
  };
}

/**
 * Safe wrapper:
 * - permanent validation failures => null
 * - transient failures => throw
 */
export function safeValidateEnvelope(
  raw,
  expectedEventType
) {
  try {
    return validateAndParseEnvelope(
      raw,
      expectedEventType
    );
  } catch (err) {
    if (
      err instanceof HireRiseError &&
      err.isPermanent
    ) {
      logger.error(
        'Permanent validation failure — routing to DLQ',
        err.toLog()
      );
      return null;
    }

    throw err;
  }
}