'use strict';

/**
 * @file core-work/src/modules/snapshot-intelligence/domain/entities/snapshot.entities.js
 *
 * KR-02A — Snapshot Domain Foundation
 *
 * Factory functions for every Snapshot Intelligence domain entity, per
 * KR-02A's "Domain Entities" deliverable. Each factory validates its
 * input (delegating to ../schemas/snapshot.validation.js) and returns a
 * deeply frozen plain object.
 *
 * Immutability enforcement (KR-01B: "snapshots are immutable", "moments
 * are immutable", "context is immutable", "historical records are
 * append-only"): every factory below deep-freezes its return value.
 * There is no setter, no update method, and no in-place mutation path
 * anywhere in this module. A changed subject state is represented by
 * constructing a *new* Snapshot with an incremented SnapshotVersion
 * (see createSnapshotVersion's `supersedes` field) — never by mutating
 * an existing one. Attempting to assign to a frozen entity's property
 * throws a TypeError in strict mode ('use strict' at the top of this
 * file and every module that constructs these entities), which is what
 * snapshot.immutability.test.js verifies.
 *
 * No persistence, no computation, no I/O. KR-02B constructs these
 * factories' outputs from stored rows; KR-02C constructs them from
 * computed interpretation results. Neither concern exists here.
 */

const validation = require('../schemas/snapshot.validation');
const { deepFreeze } = require('../value-objects/snapshot.valueObjects');

/** @returns {import('../types/snapshot.types').SnapshotIdentifier} */
function createSnapshotIdentifier(id) {
  validation.validateSnapshotIdentifier(id);
  return id;
}

/** @returns {import('../types/snapshot.types').MomentIdentifier} */
function createMomentIdentifier(id) {
  validation.validateMomentIdentifier(id);
  return id;
}

/** @returns {import('../types/snapshot.types').SubjectReference} */
function createSubjectReference({ subjectType, subjectId } = {}) {
  const ref = { subjectType, subjectId };
  validation.validateSubjectReference(ref);
  return deepFreeze(ref);
}

/** @returns {import('../types/snapshot.types').SnapshotVersion} */
function createSnapshotVersion({ version, supersedes } = {}) {
  const v = supersedes !== undefined ? { version, supersedes } : { version };
  validation.validateSnapshotVersion(v);
  return deepFreeze(v);
}

/** @returns {import('../types/snapshot.types').SnapshotState} */
function createSnapshotState({ observedFields, sourceSignals } = {}) {
  const state = {
    observedFields: observedFields ? { ...observedFields } : {},
    sourceSignals: sourceSignals ? [...sourceSignals] : [],
  };
  validation.validateSnapshotState(state);
  return deepFreeze(state);
}

/** @returns {import('../types/snapshot.types').SnapshotMetadata} */
function createSnapshotMetadata({
  createdAt, preservedAt, origin, visibility, retentionPolicy, consistencyState,
} = {}) {
  const metadata = {
    createdAt, preservedAt, origin, visibility, retentionPolicy, consistencyState,
  };
  validation.validateSnapshotMetadata(metadata);
  return deepFreeze(metadata);
}

/** @returns {import('../types/snapshot.types').SnapshotEvidenceReference} */
function createSnapshotEvidenceReference({ evidence } = {}) {
  const v = { evidence: evidence ? [...evidence] : [] };
  validation.validateSnapshotEvidenceReference(v);
  return deepFreeze(v);
}

/** @returns {import('../types/snapshot.types').EvolutionReference} */
function createEvolutionReference({ from, to, evolutionId } = {}) {
  const v = evolutionId !== undefined ? { from, to, evolutionId } : { from, to };
  validation.validateEvolutionReference(v);
  return deepFreeze(v);
}

/** @returns {import('../types/snapshot.types').NarrativeReference} */
function createNarrativeReference({ coversVersions, narrativeId } = {}) {
  const v = narrativeId !== undefined
    ? { coversVersions: [...coversVersions], narrativeId }
    : { coversVersions: [...coversVersions] };
  validation.validateNarrativeReference(v);
  return deepFreeze(v);
}

/** @returns {import('../types/snapshot.types').ExplanationReference} */
function createExplanationReference({ groundedIn, evolution } = {}) {
  const v = evolution !== undefined
    ? { groundedIn: [...groundedIn], evolution }
    : { groundedIn: [...groundedIn] };
  validation.validateExplanationReference(v);
  return deepFreeze(v);
}

/** @returns {import('../types/snapshot.types').GovernanceEvidenceReference} */
function createGovernanceEvidenceReference({ groundedIn } = {}) {
  const v = { groundedIn: [...groundedIn] };
  validation.validateGovernanceEvidenceReference(v);
  return deepFreeze(v);
}

/** @returns {import('../types/snapshot.types').Moment} */
function createMoment({
  id, subject, momentType, momentCategory, classification, timestamp, reason,
} = {}) {
  const moment = {
    id, subject, momentType, momentCategory, classification, timestamp, reason,
  };
  validation.validateMoment(moment);
  return deepFreeze(moment);
}

/** @returns {import('../types/snapshot.types').ContextEnvelope} */
function createContextEnvelope({
  id, momentId, scope, evidence,
} = {}) {
  const envelope = {
    id, momentId, scope, evidence,
  };
  validation.validateContextEnvelope(envelope);
  return deepFreeze(envelope);
}

/**
 * Constructs the Snapshot Intelligence aggregate root. This is the only
 * factory in the domain that assembles a Moment and a ContextEnvelope
 * together with version, state, and metadata into a single immutable
 * record — it performs no recognition, interpretation, or persistence;
 * it only validates structural consistency and freezes the result.
 *
 * @returns {import('../types/snapshot.types').Snapshot}
 */
function createSnapshot({
  id,
  subject,
  scope,
  moment,
  context,
  version,
  state,
  source,
  confidence,
  trigger,
  status,
  lifecycle,
  supersessionState,
  metadata,
} = {}) {
  const snapshot = {
    id,
    subject,
    scope,
    moment,
    context,
    version,
    state,
    source,
    ...(confidence !== undefined ? { confidence } : {}),
    trigger,
    ...(status !== undefined ? { status } : {}),
    lifecycle,
    supersessionState,
    metadata,
  };
  validation.validateSnapshot(snapshot);
  return deepFreeze(snapshot);
}

module.exports = {
  createSnapshotIdentifier,
  createMomentIdentifier,
  createSubjectReference,
  createSnapshotVersion,
  createSnapshotState,
  createSnapshotMetadata,
  createSnapshotEvidenceReference,
  createEvolutionReference,
  createNarrativeReference,
  createExplanationReference,
  createGovernanceEvidenceReference,
  createMoment,
  createContextEnvelope,
  createSnapshot,
};
