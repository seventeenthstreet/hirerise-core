'use strict';

const { randomUUID } = require('crypto');

// ─── Event Types ─────────────────────────────────────────────────────────────

const EventTypes = Object.freeze({
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

// ─── Topic Mapping (FIXED) ───────────────────────────────────────────────────

const Topics = Object.freeze({
  RESUME_SUBMITTED:           'hirerise.resume.submitted.v1',
  SALARY_BENCHMARK_REQUESTED: 'hirerise.salary.benchmark_requested.v1',
  CAREER_PATH_REQUESTED:      'hirerise.career.path_requested.v1',
  SCORE_UPDATED:              'hirerise.score.updated.v1',
  NOTIFICATION_REQUESTED:     'hirerise.notification.requested.v1',
});

const EventTopicMap = Object.freeze({
  [EventTypes.RESUME_SUBMITTED]: Topics.RESUME_SUBMITTED,
  [EventTypes.SALARY_BENCHMARK_REQUESTED]: Topics.SALARY_BENCHMARK_REQUESTED,
  [EventTypes.CAREER_PATH_REQUESTED]: Topics.CAREER_PATH_REQUESTED,
  [EventTypes.SCORE_UPDATED]: Topics.SCORE_UPDATED,
  [EventTypes.NOTIFICATION_REQUESTED]: Topics.NOTIFICATION_REQUESTED,
});

// ─── Schema Versions ─────────────────────────────────────────────────────────

const SchemaVersions = Object.freeze({
  [EventTypes.RESUME_SUBMITTED]:           '1.0',
  [EventTypes.SALARY_BENCHMARK_REQUESTED]: '1.0',
  [EventTypes.CAREER_PATH_REQUESTED]:      '1.0',
  [EventTypes.SCORE_UPDATED]:              '1.0',
  [EventTypes.NOTIFICATION_REQUESTED]:     '1.0',
  [EventTypes.JOB_FAILED]:                 '1.0',
  [EventTypes.JOB_DEAD]:                   '1.0',
});

// ─── Payload Contracts (unchanged, trimmed for brevity) ───────────────────────

const PayloadContracts = Object.freeze({
  [EventTypes.RESUME_SUBMITTED]: {
    required: ['userId', 'resumeId', 'jobId', 'resumeStoragePath', 'mimeType'],
    types: {
      userId: 'string',
      resumeId: 'string',
      jobId: 'string',
      resumeStoragePath: 'string',
      mimeType: 'string',
    },
  },
});

// ─── Envelope Validation ─────────────────────────────────────────────────────

const ENVELOPE_REQUIRED = [
  'eventId',
  'eventType',
  'schemaVersion',
  'publishedAt',
  'source',
  'payload',
];

function validateEnvelope(envelope) {
  const errors = [];

  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return { valid: false, errors: ['Envelope must be a non-null object'] };
  }

  for (const field of ENVELOPE_REQUIRED) {
    if (envelope[field] == null) errors.push(`Missing envelope field: ${field}`);
  }

  // Validate ISO date
  if (envelope.publishedAt && isNaN(Date.parse(envelope.publishedAt))) {
    errors.push('Invalid publishedAt timestamp');
  }

  if (!Object.values(EventTypes).includes(envelope.eventType)) {
    errors.push(`Unknown eventType: ${envelope.eventType}`);
  }

  return { valid: errors.length === 0, errors };
}

// ─── Payload Validation (Improved) ───────────────────────────────────────────

function validatePayload(eventType, payload) {
  const errors = [];
  const contract = PayloadContracts[eventType];
  if (!contract) return { valid: true, errors: [] };

  for (const field of contract.required) {
    if (payload[field] == null || payload[field] === '') {
      errors.push(`Missing required field: ${field}`);
    }
  }

  for (const [field, type] of Object.entries(contract.types ?? {})) {
    const value = payload[field];

    if (value === undefined) continue;

    if (type === 'number' && (typeof value !== 'number' || Number.isNaN(value))) {
      errors.push(`Field ${field}: invalid number`);
    }

    if (type === 'string' && typeof value !== 'string') {
      errors.push(`Field ${field}: expected string`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ─── Envelope Builder (Enhanced) ─────────────────────────────────────────────

function buildEnvelope(eventType, payload, source) {
  if (!Object.values(EventTypes).includes(eventType)) {
    throw new Error(`Unknown eventType "${eventType}"`);
  }

  const validation = validatePayload(eventType, payload);
  if (!validation.valid) {
    throw new Error(`Invalid payload: ${validation.errors.join('; ')}`);
  }

  const envelope = {
    eventId: randomUUID(),
    idempotencyKey: payload.jobId || payload.resumeId || randomUUID(), // ✅ NEW
    eventType,
    schemaVersion: SchemaVersions[eventType] ?? '1.0',
    publishedAt: new Date().toISOString(),
    source: source ?? process.env.SERVICE_NAME ?? 'hirerise',
    payload,
  };

  // Size protection (~256KB safe buffer)
  const size = Buffer.byteLength(JSON.stringify(envelope));
  if (size > 256 * 1024) {
    throw new Error(`Event too large: ${size} bytes`);
  }

  return envelope;
}

// ─── Helper ──────────────────────────────────────────────────────────────────

function getTopicForEvent(eventType) {
  const topic = EventTopicMap[eventType];
  if (!topic) {
    throw new Error(`No topic mapped for eventType: ${eventType}`);
  }
  return topic;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  EventTypes,
  Topics,
  EventTopicMap,
  SchemaVersions,
  PayloadContracts,
  validateEnvelope,
  validatePayload,
  buildEnvelope,
  getTopicForEvent,
};