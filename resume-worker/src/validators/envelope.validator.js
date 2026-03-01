/**
 * resume-worker/src/validators/envelope.validator.js
 *
 * Worker-Level Schema Validation using Zod.
 * Every message is fully validated before any business logic executes.
 * Unknown fields are STRIPPED (not rejected) — forward compatibility.
 * Missing required fields or wrong types → permanent failure → DLQ routing.
 *
 * Install: npm install zod
 */

import { z } from 'zod';
import { EventTypes, SchemaVersions } from '../../../shared/events/index.js';
import { ErrorCodes, HireRiseError } from '../../../shared/errors/index.js';
import { logger } from '../../../shared/logger/index.js';

// ─── Payload Schemas ──────────────────────────────────────────────────────────

const ResumeSubmittedPayloadSchema = z.object({
  userId:             z.string().uuid(),
  resumeId:           z.string().uuid(),
  jobId:              z.string().uuid(),
  resumeStoragePath:  z.string().min(1).max(1024),
  mimeType:           z.enum([
    'application/pdf',
    'text/plain',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ]),
}).strict(); // rejects unknown fields

const SalaryBenchmarkRequestedPayloadSchema = z.object({
  userId:         z.string().uuid(),
  jobId:          z.string().uuid(),
  jobTitle:       z.string().min(1).max(200),
  location:       z.string().min(1).max(200),
  yearsExperience:z.number().min(0).max(60),
  industry:       z.string().max(100).optional().nullable(),
}).strip(); // strips unknown optional future fields

const CareerPathRequestedPayloadSchema = z.object({
  userId:         z.string().uuid(),
  jobId:          z.string().uuid(),
  currentTitle:   z.string().min(1).max(200),
  targetTitle:    z.string().min(1).max(200),
  currentSkills:  z.array(z.string().max(100)).max(50).optional().default([]),
}).strip();

const NotificationRequestedPayloadSchema = z.object({
  userId:           z.string().uuid(),
  notificationType: z.string().min(1).max(100),
  data:             z.record(z.unknown()).optional().default({}),
}).strip();

// ─── Payload Schema Registry ──────────────────────────────────────────────────

const PAYLOAD_SCHEMAS = {
  [EventTypes.RESUME_SUBMITTED]:           ResumeSubmittedPayloadSchema,
  [EventTypes.SALARY_BENCHMARK_REQUESTED]: SalaryBenchmarkRequestedPayloadSchema,
  [EventTypes.CAREER_PATH_REQUESTED]:      CareerPathRequestedPayloadSchema,
  [EventTypes.NOTIFICATION_REQUESTED]:     NotificationRequestedPayloadSchema,
};

// ─── Envelope Schema ──────────────────────────────────────────────────────────

const BaseEnvelopeSchema = z.object({
  eventId:       z.string().uuid(),
  eventType:     z.enum(Object.values(EventTypes)),
  schemaVersion: z.string().regex(/^\d+\.\d+$/),
  publishedAt:   z.string().datetime(),
  source:        z.string().min(1).max(100),
  payload:       z.record(z.unknown()),
}).strip();

// ─── Validation Entry Point ───────────────────────────────────────────────────

/**
 * Validates and parses a deserialized Pub/Sub message envelope.
 * Throws HireRiseError with appropriate code on failure.
 *
 * @param {unknown} raw - parsed JSON from message.data
 * @param {string} expectedEventType - the event type this worker handles
 * @returns {{ envelope: ValidatedEnvelope, payload: ValidatedPayload }}
 */
export function validateAndParseEnvelope(raw, expectedEventType) {
  // Step 1: Validate envelope structure
  const envelopeResult = BaseEnvelopeSchema.safeParse(raw);
  if (!envelopeResult.success) {
    const issues = envelopeResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new HireRiseError(
      ErrorCodes.INVALID_ENVELOPE,
      `Envelope validation failed: ${issues.join('; ')}`,
      { issues }
    );
  }

  const envelope = envelopeResult.data;

  // Step 2: Reject misrouted events
  if (envelope.eventType !== expectedEventType) {
    throw new HireRiseError(
      ErrorCodes.UNKNOWN_EVENT_TYPE,
      `Worker received unexpected eventType: ${envelope.eventType}, expected: ${expectedEventType}`,
      { received: envelope.eventType, expected: expectedEventType }
    );
  }

  // Step 3: Check schema version compatibility
  const expectedVersion = SchemaVersions[envelope.eventType];
  if (expectedVersion) {
    const [inMaj] = envelope.schemaVersion.split('.').map(Number);
    const [exMaj] = expectedVersion.split('.').map(Number);
    if (inMaj !== exMaj) {
      throw new HireRiseError(
        ErrorCodes.SCHEMA_VERSION_MISMATCH,
        `Breaking schema change detected for ${envelope.eventType}: expected major v${exMaj}, got v${inMaj}`,
        { received: envelope.schemaVersion, expected: expectedVersion }
      );
    }
  }

  // Step 4: Validate payload shape
  const payloadSchema = PAYLOAD_SCHEMAS[envelope.eventType];
  if (!payloadSchema) {
    // No schema registered — pass through with warning (forward compat)
    logger.warn('No payload schema for eventType', { eventType: envelope.eventType });
    return { envelope, payload: envelope.payload };
  }

  const payloadResult = payloadSchema.safeParse(envelope.payload);
  if (!payloadResult.success) {
    const issues = payloadResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new HireRiseError(
      ErrorCodes.INVALID_PAYLOAD,
      `Payload validation failed for ${envelope.eventType}: ${issues.join('; ')}`,
      { issues, eventType: envelope.eventType }
    );
  }

  return { envelope, payload: payloadResult.data };
}

/**
 * Safe wrapper — returns null on permanent validation failures.
 * The caller must ack the message and skip processing.
 *
 * Returns null if the error is permanent (DLQ case).
 * Rethrows transient errors for Pub/Sub nack + retry.
 */
export function safeValidateEnvelope(raw, expectedEventType) {
  try {
    return validateAndParseEnvelope(raw, expectedEventType);
  } catch (err) {
    if (err instanceof HireRiseError && err.isPermanent) {
      logger.error('Permanent validation failure — routing to DLQ', err.toLog());
      return null; // caller must ack to let Pub/Sub eventually route to DLQ
    }
    throw err; // transient — let it nack
  }
}
