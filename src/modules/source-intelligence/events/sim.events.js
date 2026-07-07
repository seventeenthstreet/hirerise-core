'use strict';

/**
 * src/modules/source-intelligence/events/sim.events.js
 *
 * WP-P2-01 — Integration point with COM (deliverable #20)
 *
 * SIM does not collect, transform, or publish knowledge. What it DOES do
 * is tell downstream subsystems — starting with COM (Collection Orchestration
 * / Management, the next work package in the Phase-2 pipeline) — that a
 * source now exists, changed, or is no longer eligible for collection.
 *
 * This module defines that contract as a set of transport-agnostic event
 * envelopes, following the same envelope shape already established in
 * shared/events/index.js (eventId, eventType, schemaVersion, publishedAt,
 * source, payload). SIM emits these; it does not care who — today, COM —
 * subscribes.
 *
 * IMPORTANT: This is a contract definition + in-process emitter only.
 * Wiring to a real transport (outbox table, pub/sub, queue) is an
 * infrastructure decision that belongs to whoever integrates COM, and is
 * intentionally left as an injectable `publish` function so this module
 * has zero hard dependency on a specific transport.
 */

const { randomUUID } = require('crypto');
const logger = require('../../../utils/logger');

const SIM_EVENT_TYPES = Object.freeze({
  SOURCE_REGISTERED: 'SIM.SOURCE_REGISTERED',
  SOURCE_METADATA_UPDATED: 'SIM.SOURCE_METADATA_UPDATED',
  SOURCE_STATUS_CHANGED: 'SIM.SOURCE_STATUS_CHANGED',
  SOURCE_TRUST_SCORE_UPDATED: 'SIM.SOURCE_TRUST_SCORE_UPDATED',
  SOURCE_HEALTH_CHANGED: 'SIM.SOURCE_HEALTH_CHANGED',
  SOURCE_ARCHIVED: 'SIM.SOURCE_ARCHIVED',
  SOURCE_ELIGIBLE_FOR_COLLECTION: 'SIM.SOURCE_ELIGIBLE_FOR_COLLECTION',
  SOURCE_INELIGIBLE_FOR_COLLECTION: 'SIM.SOURCE_INELIGIBLE_FOR_COLLECTION',
  // Enterprise Enhancement 8 — Source Relationship Model
  SOURCE_RELATIONSHIP_ADDED: 'SIM.SOURCE_RELATIONSHIP_ADDED',
  SOURCE_RELATIONSHIP_REMOVED: 'SIM.SOURCE_RELATIONSHIP_REMOVED',
});

const SIM_SCHEMA_VERSION = '1.0';

const SIM_EVENT_SOURCE = 'hirerise.sim';

/**
 * Sources become eligible for COM to schedule collection against only once
 * they are ACTIVE and have passed governance approval. This is the single
 * predicate COM should trust rather than re-deriving eligibility itself.
 */
function isEligibleForCollection(source) {
  return (
    source?.status === 'active' &&
    (source?.approvalStatus === 'approved' || source?.approvalStatus === undefined)
  );
}

function buildEnvelope(eventType, payload, meta = {}) {
  return {
    eventId: randomUUID(),
    eventType,
    schemaVersion: SIM_SCHEMA_VERSION,
    publishedAt: new Date().toISOString(),
    source: SIM_EVENT_SOURCE,
    payload,
    meta,
  };
}

/**
 * Default no-op publisher. Callers (server bootstrap, workers, tests) should
 * inject a real publisher — e.g. one backed by shared/events outbox — via
 * `configurePublisher`. Kept as a safe default so the service layer never
 * throws just because no transport has been wired up yet.
 */
let publisher = async (envelope) => {
  logger.debug?.('[SIM.events] no publisher configured, dropping event', {
    eventType: envelope.eventType,
    eventId: envelope.eventId,
  });
};

function configurePublisher(fn) {
  if (typeof fn !== 'function') {
    throw new TypeError('configurePublisher requires a function');
  }
  publisher = fn;
}

async function emit(eventType, payload, meta = {}) {
  const envelope = buildEnvelope(eventType, payload, meta);

  try {
    await publisher(envelope);
  } catch (err) {
    // Event delivery failures must never break the SIM write path itself —
    // registry state is the source of truth; event delivery is best-effort
    // until a durable outbox is wired in by the COM integration.
    logger.error('[SIM.events] publish failed', {
      eventType,
      eventId: envelope.eventId,
      error: err.message,
    });
  }

  return envelope;
}

module.exports = {
  SIM_EVENT_TYPES,
  SIM_SCHEMA_VERSION,
  SIM_EVENT_SOURCE,
  isEligibleForCollection,
  configurePublisher,
  emit,
};
