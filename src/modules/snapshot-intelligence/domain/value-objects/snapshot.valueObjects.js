'use strict';

/**
 * @file core-work/src/modules/snapshot-intelligence/domain/value-objects/snapshot.valueObjects.js
 *
 * KR-02A — Snapshot Domain Foundation
 *
 * Factory functions for every Snapshot Intelligence value object, per
 * KR-02A's "Value Objects" deliverable. Each factory validates its input
 * (delegating to ../schemas/snapshot.validation.js) and returns a deeply
 * frozen plain object — value objects have no identity and no mutable
 * state, per KR-01B's Historical Truth principle applied at the
 * implementation layer.
 *
 * These are plain-object factories, not classes, consistent with this
 * repository's existing domain convention of representing shapes as
 * plain objects documented via JSDoc typedefs (see ../types/snapshot.types.js)
 * rather than introducing a class hierarchy for value semantics.
 */

const validation = require('../schemas/snapshot.validation');

function deepFreeze(obj) {
  Object.getOwnPropertyNames(obj).forEach((key) => {
    const value = obj[key];
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  });
  return Object.freeze(obj);
}

/** @returns {import('../types/snapshot.types').MomentType} */
function createMomentType(value) {
  validation.validateMomentType(value);
  return value;
}

/** @returns {import('../types/snapshot.types').MomentCategory} */
function createMomentCategory(value) {
  validation.validateMomentCategory(value);
  return value;
}

/** @returns {import('../types/snapshot.types').SnapshotTimestamp} */
function createSnapshotTimestamp({ occurredAt, preservedAt } = {}) {
  const timestamp = preservedAt !== undefined ? { occurredAt, preservedAt } : { occurredAt };
  validation.validateSnapshotTimestamp(timestamp);
  return deepFreeze(timestamp);
}

/** @returns {import('../types/snapshot.types').SnapshotReason} */
function createSnapshotReason({ code, description } = {}) {
  const reason = description !== undefined ? { code, description } : { code };
  validation.validateSnapshotReason(reason);
  return deepFreeze(reason);
}

/** @returns {import('../types/snapshot.types').SnapshotSource} */
function createSnapshotSource({ capability, eventId } = {}) {
  const source = eventId !== undefined ? { capability, eventId } : { capability };
  validation.validateSnapshotSource(source);
  return deepFreeze(source);
}

/** @returns {import('../types/snapshot.types').SnapshotConfidence} */
function createSnapshotConfidence({ score, band } = {}) {
  const confidence = band !== undefined ? { score, band } : { score };
  validation.validateSnapshotConfidence(confidence);
  return deepFreeze(confidence);
}

/** @returns {import('../types/snapshot.types').SnapshotTrigger} */
function createSnapshotTrigger({ origin, triggerId } = {}) {
  const trigger = triggerId !== undefined ? { origin, triggerId } : { origin };
  validation.validateSnapshotTrigger(trigger);
  return deepFreeze(trigger);
}

/** @returns {import('../types/snapshot.types').SnapshotScope} */
function createSnapshotScope(value) {
  validation.validateSnapshotScope(value);
  return value;
}

/** @returns {import('../types/snapshot.types').SnapshotStatus} */
function createSnapshotStatus(value) {
  validation.validateSnapshotStatus(value);
  return value;
}

/** @returns {import('../types/snapshot.types').ContextScope} */
function createContextScope({ type, domains } = {}) {
  const scope = { type, domains: domains ? [...domains] : [] };
  validation.validateContextScope(scope);
  return deepFreeze(scope);
}

/** @returns {import('../types/snapshot.types').EvidenceReference} */
function createEvidenceReference({ evidenceType, referenceId, sourceCapability } = {}) {
  const ref = { evidenceType, referenceId, sourceCapability };
  validation.validateEvidenceReference(ref);
  return deepFreeze(ref);
}

/** @returns {import('../types/snapshot.types').SignalReference} */
function createSignalReference({ signalType, referenceId, observedValue } = {}) {
  const ref = observedValue !== undefined ? { signalType, referenceId, observedValue } : { signalType, referenceId };
  validation.validateSignalReference(ref);
  return deepFreeze(ref);
}

/** @returns {import('../types/snapshot.types').DomainReference} */
function createDomainReference({ domainName } = {}) {
  const ref = { domainName };
  validation.validateDomainReference(ref);
  return deepFreeze(ref);
}

/** @returns {import('../types/snapshot.types').RelationshipReference} */
function createRelationshipReference({ targetType, targetId } = {}) {
  const ref = { targetType, targetId };
  validation.validateRelationshipReference(ref);
  return deepFreeze(ref);
}

/** @returns {import('../types/snapshot.types').VersionReference} */
function createVersionReference({ snapshotId, version } = {}) {
  const ref = { snapshotId, version };
  validation.validateVersionReference(ref);
  return deepFreeze(ref);
}

module.exports = {
  createMomentType,
  createMomentCategory,
  createSnapshotTimestamp,
  createSnapshotReason,
  createSnapshotSource,
  createSnapshotConfidence,
  createSnapshotTrigger,
  createSnapshotScope,
  createSnapshotStatus,
  createContextScope,
  createEvidenceReference,
  createSignalReference,
  createDomainReference,
  createRelationshipReference,
  createVersionReference,
  deepFreeze,
};
