'use strict';

/**
 * @file core-work/src/modules/snapshot-intelligence/domain/events/snapshot.eventContracts.js
 *
 * KR-02A — Snapshot Domain Foundation
 *
 * Event payload contracts, per KR-02A's "Shared Contracts" ›
 * "Event Payload Contracts" deliverable. These name and shape the three
 * producer events KR-02 §10.2 assigns to Snapshot Intelligence
 * (snapshot-created, snapshot-superseded, recalculation-completed) so
 * that KR-02D can wire them onto the platform's existing shared/events
 * and shared/pubsub infrastructure without inventing the payload shape
 * at that point.
 *
 * KR-02A defines the contract only. No publish call, no subscription,
 * and no dependency on shared/events or shared/pubsub exists in this
 * file or anywhere else in this work package — wiring is KR-02D's scope.
 */

const EVENT_TYPES = Object.freeze({
  SNAPSHOT_CREATED: 'snapshot-created',
  SNAPSHOT_SUPERSEDED: 'snapshot-superseded',
  RECALCULATION_COMPLETED: 'recalculation-completed',
});

/**
 * @typedef {Object} SnapshotCreatedEventPayload
 * @property {string} eventType - always EVENT_TYPES.SNAPSHOT_CREATED
 * @property {string} snapshotId
 * @property {import('../types/snapshot.types').SubjectReference} subject
 * @property {string} scope
 * @property {number} version
 * @property {string} occurredAt
 */

/**
 * @param {import('../types/snapshot.types').Snapshot} snapshot
 * @returns {SnapshotCreatedEventPayload}
 */
function buildSnapshotCreatedPayload(snapshot) {
  return {
    eventType: EVENT_TYPES.SNAPSHOT_CREATED,
    snapshotId: snapshot.id,
    subject: snapshot.subject,
    scope: snapshot.scope,
    version: snapshot.version.version,
    occurredAt: snapshot.moment.timestamp.occurredAt,
  };
}

/**
 * @typedef {Object} SnapshotSupersededEventPayload
 * @property {string} eventType - always EVENT_TYPES.SNAPSHOT_SUPERSEDED
 * @property {string} snapshotId - the snapshot that is now superseded
 * @property {string} supersededBySnapshotId
 * @property {import('../types/snapshot.types').SubjectReference} subject
 * @property {string} scope
 */

/**
 * @param {import('../types/snapshot.types').Snapshot} supersededSnapshot
 * @param {import('../types/snapshot.types').Snapshot} newSnapshot
 * @returns {SnapshotSupersededEventPayload}
 */
function buildSnapshotSupersededPayload(supersededSnapshot, newSnapshot) {
  return {
    eventType: EVENT_TYPES.SNAPSHOT_SUPERSEDED,
    snapshotId: supersededSnapshot.id,
    supersededBySnapshotId: newSnapshot.id,
    subject: supersededSnapshot.subject,
    scope: supersededSnapshot.scope,
  };
}

/**
 * @typedef {Object} RecalculationCompletedEventPayload
 * @property {string} eventType - always EVENT_TYPES.RECALCULATION_COMPLETED
 * @property {import('../types/snapshot.types').SubjectReference} subject
 * @property {string} scope
 * @property {string} triggerId
 * @property {string} resultingSnapshotId
 */

/**
 * @param {{subject: import('../types/snapshot.types').SubjectReference, scope: string, triggerId: string, resultingSnapshotId: string}} params
 * @returns {RecalculationCompletedEventPayload}
 */
function buildRecalculationCompletedPayload({
  subject, scope, triggerId, resultingSnapshotId,
}) {
  return {
    eventType: EVENT_TYPES.RECALCULATION_COMPLETED,
    subject,
    scope,
    triggerId,
    resultingSnapshotId,
  };
}

module.exports = {
  EVENT_TYPES,
  buildSnapshotCreatedPayload,
  buildSnapshotSupersededPayload,
  buildRecalculationCompletedPayload,
};
