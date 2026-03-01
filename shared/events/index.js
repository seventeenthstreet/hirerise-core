/**
 * shared/events/index.js
 *
 * Global Event Contract Registry — single source of truth for all
 * event types, topic names, schema versions, and envelope validation.
 *
 * All services import from this module. No string literals allowed anywhere.
 *
 * Backward Compatibility:
 *   MINOR version bumps: additive fields only. Consumers must tolerate unknown fields.
 *   MAJOR version bumps: new topic suffix (.v2). Workers migrate explicitly.
 */

import { randomUUID } from 'crypto';

// ─── Event Type Enum ──────────────────────────────────────────────────────────

export const EventTypes = Object.freeze({
  RESUME_SUBMITTED:           'RESUME_SUBMITTED',
  RESUME_PARSED:              'RESUME_PARSED',
  SCORE_UPDATED:              'SCORE_UPDATED',
  SALARY_BENCHMARK_REQUESTED: 'SALARY_BENCHMARK_REQUESTED',
  SALARY_BENCHMARK_COMPLETE:  'SALARY_BENCHMARK_COMPLETE',
  CAREER_PATH_REQUESTED:      'CAREER_PATH_REQUESTED',
  CAREER_PATH_COMPLETE:       'CAREER_PATH_COMPLETE',
  NOTIFICATION_REQUESTED:     'NOTIFICATION_REQUESTED',
  NOTIFICATION_SENT:          'NOTIFICATION_SENT',
  NOTIFICATION_FAILED:        'NOTIFICATION_FAILED',
  JOB_FAILED:                 'JOB_FAILED',
  JOB_DEAD:                   'JOB_DEAD',
});

// ─── Topic Registry ───────────────────────────────────────────────────────────

export const Topics = Object.freeze({
  RESUME_SUBMITTED:           'hirerise.resume.submitted.v1',
  SALARY_BENCHMARK_REQUESTED: 'hirerise.salary.benchmark_requested.v1',
  CAREER_PATH_REQUESTED:      'hirerise.career.path_requested.v1',
  SCORE_UPDATED:              'hirerise.score.updated.v1',
  NOTIFICATION_REQUESTED:     'hirerise.notification.requested.v1',
  DLQ_RESUME:                 'hirerise.dlq.resume.v1',
  DLQ_SALARY:                 'hirerise.dlq.salary.v1',
  DLQ_CAREER:                 'hirerise.dlq.career.v1',
  DLQ_NOTIFICATION:           'hirerise.dlq.notification.v1',
});

// ─── Schema Version Registry ──────────────────────────────────────────────────

export const SchemaVersions = Object.freeze({
  [EventTypes.RESUME_SUBMITTED]:           '1.0',
  [EventTypes.SALARY_BENCHMARK_REQUESTED]: '1.0',
  [EventTypes.CAREER_PATH_REQUESTED]:      '1.0',
  [EventTypes.SCORE_UPDATED]:              '1.0',
  [EventTypes.NOTIFICATION_REQUESTED]:     '1.0',
  [EventTypes.JOB_FAILED]:                 '1.0',
  [EventTypes.JOB_DEAD]:                   '1.0',
});

// ─── Payload Contracts ────────────────────────────────────────────────────────
// Defines required fields and types per event. Used for worker-level validation.

export const PayloadContracts = Object.freeze({
  [EventTypes.RESUME_SUBMITTED]: {
    required: ['userId', 'resumeId', 'jobId', 'resumeStoragePath', 'mimeType'],
    types: {
      userId: 'string', resumeId: 'string', jobId: 'string',
      resumeStoragePath: 'string', mimeType: 'string',
    },
    allowedMimeTypes: [
      'application/pdf', 'text/plain', 'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
  },
  [EventTypes.SALARY_BENCHMARK_REQUESTED]: {
    required: ['userId', 'jobId', 'jobTitle', 'location', 'yearsExperience'],
    types: {
      userId: 'string', jobId: 'string', jobTitle: 'string',
      location: 'string', yearsExperience: 'number',
    },
  },
  [EventTypes.CAREER_PATH_REQUESTED]: {
    required: ['userId', 'jobId', 'currentTitle', 'targetTitle'],
    types: { userId: 'string', jobId: 'string', currentTitle: 'string', targetTitle: 'string' },
  },
  [EventTypes.NOTIFICATION_REQUESTED]: {
    required: ['userId', 'notificationType'],
    types: { userId: 'string', notificationType: 'string' },
  },
  [EventTypes.SCORE_UPDATED]: {
    required: ['userId', 'resumeId', 'overallScore', 'engineVersion'],
    types: { userId: 'string', resumeId: 'string', overallScore: 'number', engineVersion: 'string' },
  },
});

// ─── Envelope Validation ──────────────────────────────────────────────────────

const ENVELOPE_REQUIRED = ['eventId', 'eventType', 'schemaVersion', 'publishedAt', 'source', 'payload'];

export function validateEnvelope(envelope) {
  const errors = [];

  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return { valid: false, errors: ['Envelope must be a non-null object'] };
  }

  for (const field of ENVELOPE_REQUIRED) {
    if (envelope[field] == null) errors.push(`Missing envelope field: ${field}`);
  }

  if (errors.length > 0) return { valid: false, errors };

  if (!Object.values(EventTypes).includes(envelope.eventType)) {
    errors.push(`Unknown eventType: ${envelope.eventType}`);
  }

  const expected = SchemaVersions[envelope.eventType];
  if (expected && !isCompatibleVersion(envelope.schemaVersion, expected)) {
    errors.push(`Schema mismatch for ${envelope.eventType}: expected ${expected}, got ${envelope.schemaVersion}`);
  }

  if (typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)) {
    errors.push('payload must be a non-array object');
  }

  return { valid: errors.length === 0, errors };
}

export function validatePayload(eventType, payload) {
  const errors = [];
  const contract = PayloadContracts[eventType];
  if (!contract) return { valid: true, errors: [] };

  for (const field of contract.required) {
    if (payload[field] == null || payload[field] === '') {
      errors.push(`Missing required field: ${field}`);
    }
  }

  for (const [field, type] of Object.entries(contract.types ?? {})) {
    if (payload[field] !== undefined && typeof payload[field] !== type) {
      errors.push(`Field ${field}: expected ${type}, got ${typeof payload[field]}`);
    }
  }

  if (contract.allowedMimeTypes && payload.mimeType) {
    if (!contract.allowedMimeTypes.includes(payload.mimeType)) {
      errors.push(`Invalid mimeType: ${payload.mimeType}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ─── Schema Version Compatibility ────────────────────────────────────────────
// MAJOR must match. MINOR incoming >= expected minor (forward compatible reads).

function isCompatibleVersion(incoming, expected) {
  if (!incoming || !expected) return false;
  const [inMaj, inMin = 0] = incoming.split('.').map(Number);
  const [exMaj, exMin = 0] = expected.split('.').map(Number);
  return inMaj === exMaj && inMin >= exMin;
}

// ─── Envelope Builder ─────────────────────────────────────────────────────────

export function buildEnvelope(eventType, payload, source) {
  if (!Object.values(EventTypes).includes(eventType)) {
    throw new Error(`buildEnvelope: unknown eventType "${eventType}"`);
  }

  const validation = validatePayload(eventType, payload);
  if (!validation.valid) {
    throw new Error(`buildEnvelope: invalid payload for ${eventType}: ${validation.errors.join('; ')}`);
  }

  return {
    eventId:       randomUUID(),
    eventType,
    schemaVersion: SchemaVersions[eventType] ?? '1.0',
    publishedAt:   new Date().toISOString(),
    source:        source ?? process.env.SERVICE_NAME ?? 'hirerise',
    payload,
  };
}
