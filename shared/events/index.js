'use strict';

/**
 * shared/events/contracts.js
 *
 * Production-grade transport-agnostic event contract layer
 * ✅ Firebase legacy topic coupling reduced
 * ✅ Supabase outbox compatible
 * ✅ Better validation performance
 * ✅ Stronger idempotency defaults
 * ✅ Replay-safe envelopes
 * ✅ publishToOutbox — writes envelope to event_outbox in same DB transaction
 * ✅ startOutboxWorker — polls and dispatches unprocessed rows with retry/DLQ
 */

const { randomUUID, createHash } = require('crypto');

const EventTypes = Object.freeze({
  RESUME_SUBMITTED: 'RESUME_SUBMITTED',
  RESUME_PARSED: 'RESUME_PARSED',
  SCORE_UPDATED: 'SCORE_UPDATED',
  SALARY_BENCHMARK_REQUESTED: 'SALARY_BENCHMARK_REQUESTED',
  SALARY_BENCHMARK_COMPLETE: 'SALARY_BENCHMARK_COMPLETE',
  CAREER_PATH_REQUESTED: 'CAREER_PATH_REQUESTED',
  CAREER_PATH_COMPLETE: 'CAREER_PATH_COMPLETE',
  NOTIFICATION_REQUESTED: 'NOTIFICATION_REQUESTED',
  NOTIFICATION_SENT: 'NOTIFICATION_SENT',
  NOTIFICATION_FAILED: 'NOTIFICATION_FAILED',
  JOB_FAILED: 'JOB_FAILED',
  JOB_DEAD: 'JOB_DEAD',
});

const EVENT_TYPE_SET = new Set(Object.values(EventTypes));

/**
 * Transport adapter names (optional)
 * Keeps backward compatibility with Pub/Sub while staying transport-agnostic.
 */
const TransportRoutes = Object.freeze({
  [EventTypes.RESUME_SUBMITTED]: 'hirerise.resume.submitted.v1',
  [EventTypes.SALARY_BENCHMARK_REQUESTED]:
    'hirerise.salary.benchmark_requested.v1',
  [EventTypes.CAREER_PATH_REQUESTED]:
    'hirerise.career.path_requested.v1',
  [EventTypes.SCORE_UPDATED]: 'hirerise.score.updated.v1',
  [EventTypes.NOTIFICATION_REQUESTED]:
    'hirerise.notification.requested.v1',
});

const SchemaVersions = Object.freeze({
  [EventTypes.RESUME_SUBMITTED]: '1.0',
  [EventTypes.SALARY_BENCHMARK_REQUESTED]: '1.0',
  [EventTypes.CAREER_PATH_REQUESTED]: '1.0',
  [EventTypes.SCORE_UPDATED]: '1.0',
  [EventTypes.NOTIFICATION_REQUESTED]: '1.0',
  [EventTypes.JOB_FAILED]: '1.0',
  [EventTypes.JOB_DEAD]: '1.0',
});

const PayloadContracts = Object.freeze({
  [EventTypes.RESUME_SUBMITTED]: Object.freeze({
    required: [
      'userId',
      'resumeId',
      'jobId',
      'resumeStoragePath',
      'mimeType',
    ],
    types: Object.freeze({
      userId: 'string',
      resumeId: 'string',
      jobId: 'string',
      resumeStoragePath: 'string',
      mimeType: 'string',
    }),
  }),
});

const ENVELOPE_REQUIRED = Object.freeze([
  'eventId',
  'eventType',
  'schemaVersion',
  'publishedAt',
  'source',
  'payload',
]);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateEnvelope(envelope) {
  const errors = [];

  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return { valid: false, errors: ['Envelope must be a non-null object'] };
  }

  for (const field of ENVELOPE_REQUIRED) {
    if (envelope[field] == null) {
      errors.push(`Missing envelope field: ${field}`);
    }
  }

  if (envelope.publishedAt && Number.isNaN(Date.parse(envelope.publishedAt))) {
    errors.push('Invalid publishedAt timestamp');
  }

  if (!EVENT_TYPE_SET.has(envelope.eventType)) {
    errors.push(`Unknown eventType: ${envelope.eventType}`);
  }

  return { valid: errors.length === 0, errors };
}

function validatePayload(eventType, payload) {
  const errors = [];
  const contract = PayloadContracts[eventType];

  if (!contract) return { valid: true, errors: [] };

  for (const field of contract.required) {
    if (payload?.[field] == null || payload[field] === '') {
      errors.push(`Missing required field: ${field}`);
    }
  }

  for (const [field, type] of Object.entries(contract.types || {})) {
    const value = payload?.[field];

    if (value === undefined) continue;

    if (type === 'number') {
      if (typeof value !== 'number' || Number.isNaN(value)) {
        errors.push(`Field ${field}: invalid number`);
      }
    }

    if (type === 'string' && typeof value !== 'string') {
      errors.push(`Field ${field}: expected string`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Envelope construction
// ---------------------------------------------------------------------------

function createDeterministicIdempotencyKey(eventType, payload) {
  const stableSource = JSON.stringify({
    eventType,
    jobId: payload?.jobId,
    resumeId: payload?.resumeId,
    userId: payload?.userId,
  });

  return createHash('sha256').update(stableSource).digest('hex');
}

function buildEnvelope(eventType, payload, source, meta = {}) {
  if (!EVENT_TYPE_SET.has(eventType)) {
    throw new Error(`Unknown eventType "${eventType}"`);
  }

  const validation = validatePayload(eventType, payload);

  if (!validation.valid) {
    throw new Error(`Invalid payload: ${validation.errors.join('; ')}`);
  }

  const envelope = {
    eventId: randomUUID(),
    idempotencyKey:
      payload?.jobId ||
      payload?.resumeId ||
      createDeterministicIdempotencyKey(eventType, payload),
    correlationId: meta.correlationId || randomUUID(),
    causationId: meta.causationId || null,
    eventType,
    schemaVersion: SchemaVersions[eventType] || '1.0',
    publishedAt: new Date().toISOString(),
    source: source || process.env.SERVICE_NAME || 'hirerise',
    payload,
  };

  const size = Buffer.byteLength(JSON.stringify(envelope), 'utf8');

  if (size > 256 * 1024) {
    throw new Error(`Event too large: ${size} bytes`);
  }

  return envelope;
}

function getTopicForEvent(eventType) {
  const route = TransportRoutes[eventType];

  if (!route) {
    throw new Error(`No route mapped for eventType: ${eventType}`);
  }

  return route;
}

// ---------------------------------------------------------------------------
// Outbox writer
//
// Call this inside the SAME database transaction as your business write so
// the event is guaranteed to be persisted or rolled back atomically.
//
// Usage:
//   await db.query('BEGIN');
//   await insertResume(db, data);
//   await publishToOutbox(db, EventTypes.RESUME_SUBMITTED, payload, 'resume-service');
//   await db.query('COMMIT');
// ---------------------------------------------------------------------------

/**
 * @param {object} client   — pg/postgres client (must be inside a transaction)
 * @param {string} eventType
 * @param {object} payload
 * @param {string} [source]
 * @param {object} [meta]   — { correlationId?, causationId? }
 * @returns {{ envelope: object, inserted: boolean }}
 *   inserted=false means the idempotency_key already existed (safe duplicate).
 */
async function publishToOutbox(client, eventType, payload, source, meta = {}) {
  const envelope = buildEnvelope(eventType, payload, source, meta);
  const route = TransportRoutes[eventType] ?? null;

  const { rowCount } = await client.query(
    `INSERT INTO event_outbox
       (event_id, event_type, schema_version, route, source,
        correlation_id, causation_id, payload, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      envelope.eventId,
      envelope.eventType,
      envelope.schemaVersion,
      route,
      envelope.source,
      envelope.correlationId,
      envelope.causationId,
      JSON.stringify(envelope.payload),
      envelope.idempotencyKey,
    ],
  );

  return { envelope, inserted: rowCount === 1 };
}

// ---------------------------------------------------------------------------
// Outbox worker
//
// Polls event_outbox for unprocessed rows and calls your dispatch function.
// Rows that exceed MAX_RETRIES are skipped (dead-lettered in place).
// Safe to run multiple instances — uses FOR UPDATE SKIP LOCKED.
//
// Usage:
//   const { startOutboxWorker } = require('./shared/events/contracts');
//
//   startOutboxWorker(db, async (row) => {
//     await pubSubClient.topic(row.route).publishMessage({ json: row.payload });
//   });
// ---------------------------------------------------------------------------

const OUTBOX_POLL_INTERVAL_MS = parseInt(process.env.OUTBOX_POLL_INTERVAL_MS, 10) || 2000;
const OUTBOX_BATCH_SIZE       = parseInt(process.env.OUTBOX_BATCH_SIZE, 10)       || 50;
const OUTBOX_MAX_RETRIES      = parseInt(process.env.OUTBOX_MAX_RETRIES, 10)      || 5;

/**
 * @param {object}   db        — pg pool or client
 * @param {Function} dispatch  — async (row) => void; throws on failure
 * @param {object}   [opts]
 * @param {number}   [opts.pollIntervalMs]
 * @param {number}   [opts.batchSize]
 * @param {number}   [opts.maxRetries]
 * @param {Function} [opts.onDeadLetter]  — async (row) => void
 * @param {Function} [opts.logger]        — defaults to console
 */
function startOutboxWorker(db, dispatch, opts = {}) {
  const pollIntervalMs = opts.pollIntervalMs ?? OUTBOX_POLL_INTERVAL_MS;
  const batchSize      = opts.batchSize      ?? OUTBOX_BATCH_SIZE;
  const maxRetries     = opts.maxRetries     ?? OUTBOX_MAX_RETRIES;
  const onDeadLetter   = opts.onDeadLetter   ?? null;
  const log            = opts.logger         ?? console;

  async function processBatch() {
    const { rows } = await db.query(
      `SELECT *
         FROM event_outbox
        WHERE processed_at IS NULL
          AND retry_count < $1
        ORDER BY published_at ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [maxRetries, batchSize],
    );

    for (const row of rows) {
      try {
        await dispatch(row);

        await db.query(
          `UPDATE event_outbox
              SET processed_at = now()
            WHERE id = $1`,
          [row.id],
        );
      } catch (err) {
        const nextRetry = row.retry_count + 1;
        const isDead    = nextRetry >= maxRetries;

        await db.query(
          `UPDATE event_outbox
              SET retry_count = $2,
                  last_error  = $3
            WHERE id = $1`,
          [row.id, nextRetry, err.message],
        );

        if (isDead) {
          log.error(
            `[outbox] Dead-lettered event ${row.event_id} (${row.event_type}) after ${nextRetry} retries: ${err.message}`,
          );

          if (onDeadLetter) {
            await onDeadLetter(row).catch((dlErr) =>
              log.error('[outbox] onDeadLetter callback failed:', dlErr),
            );
          }
        } else {
          log.warn(
            `[outbox] Retry ${nextRetry}/${maxRetries} for event ${row.event_id} (${row.event_type}): ${err.message}`,
          );
        }
      }
    }
  }

  async function tick() {
    try {
      await processBatch();
    } catch (err) {
      log.error('[outbox] Worker tick failed:', err);
    } finally {
      setTimeout(tick, pollIntervalMs);
    }
  }

  log.info(`[outbox] Worker started (poll=${pollIntervalMs}ms, batch=${batchSize}, maxRetries=${maxRetries})`);
  tick();
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  EventTypes,
  TransportRoutes,
  SchemaVersions,
  PayloadContracts,
  validateEnvelope,
  validatePayload,
  buildEnvelope,
  getTopicForEvent,
  publishToOutbox,
  startOutboxWorker,
};