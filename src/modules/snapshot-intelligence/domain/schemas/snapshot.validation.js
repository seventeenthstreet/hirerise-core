'use strict';

/**
 * @file core-work/src/modules/snapshot-intelligence/domain/schemas/snapshot.validation.js
 *
 * KR-02A — Snapshot Domain Foundation
 *
 * Deterministic, dependency-free validation functions for every Snapshot
 * Intelligence entity and value object, per KR-02A's "Validation" and
 * "Shared Contracts / Validation Contracts" deliverables.
 *
 * Convention: this repository's existing domain-validation code
 * (src/domain/studentProfile/studentProfile.writeValidation.js) hand-writes
 * small, pure validator functions rather than a declarative schema
 * library (no zod/joi/yup at the domain layer — those are used only at
 * the HTTP boundary in api-service/src/validations). This module follows
 * that same convention for consistency with the rest of the domain layer.
 *
 * PURE FUNCTIONS ONLY — no I/O, no logging, no randomness, no reliance on
 * ambient state (e.g. current time is always passed in, never read via
 * `Date.now()` inside a validator), so that validation is fully
 * deterministic per KR-02A's explicit requirement.
 *
 * Every validator either returns void (valid) or throws
 * SnapshotValidationError (invalid) with a message naming the offending
 * field. None of these validators mutate their input.
 */

const { SnapshotValidationError } = require('../errors/snapshot.errors');
const {
  MomentClassification,
  SnapshotLifecycle,
  SnapshotSupersessionState,
  SnapshotOrigin,
  SnapshotVisibility,
  SnapshotRetentionPolicy,
  SnapshotConsistencyState,
  ContextType,
  EvidenceType,
  SignalType,
} = require('../constants/snapshot.constants');

// ─────────────────────────────────────────────────────────────────────────
// PRIMITIVES
// ─────────────────────────────────────────────────────────────────────────

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isArray(v) {
  return Array.isArray(v);
}

function isIsoTimestamp(v) {
  if (!isNonEmptyString(v)) return false;
  const parsed = Date.parse(v);
  return Number.isFinite(parsed);
}

function isEnumMember(enumObject, v) {
  return isNonEmptyString(v) && Object.values(enumObject).includes(v);
}

function assert(condition, message, field) {
  if (!condition) {
    throw new SnapshotValidationError(message, { field });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// IDENTIFIERS & REFERENCES
// ─────────────────────────────────────────────────────────────────────────

function validateSnapshotIdentifier(id) {
  assert(isNonEmptyString(id), 'SnapshotIdentifier must be a non-empty string', 'id');
}

function validateMomentIdentifier(id) {
  assert(isNonEmptyString(id), 'MomentIdentifier must be a non-empty string', 'id');
}

function validateSubjectReference(ref) {
  assert(isPlainObject(ref), 'SubjectReference must be an object', 'subject');
  assert(
    ref.subjectType === 'STUDENT' || ref.subjectType === 'PROFESSIONAL',
    'SubjectReference.subjectType must be STUDENT or PROFESSIONAL',
    'subject.subjectType',
  );
  assert(isNonEmptyString(ref.subjectId), 'SubjectReference.subjectId must be a non-empty string', 'subject.subjectId');
}

// ─────────────────────────────────────────────────────────────────────────
// VALUE OBJECTS
// ─────────────────────────────────────────────────────────────────────────

function validateMomentType(v) {
  assert(isNonEmptyString(v), 'MomentType must be a non-empty string', 'momentType');
}

function validateMomentCategory(v) {
  assert(isNonEmptyString(v), 'MomentCategory must be a non-empty string', 'momentCategory');
}

function validateSnapshotTimestamp(ts) {
  assert(isPlainObject(ts), 'SnapshotTimestamp must be an object', 'timestamp');
  assert(isIsoTimestamp(ts.occurredAt), 'SnapshotTimestamp.occurredAt must be a valid ISO-8601 timestamp', 'timestamp.occurredAt');
  if (ts.preservedAt !== undefined) {
    assert(isIsoTimestamp(ts.preservedAt), 'SnapshotTimestamp.preservedAt must be a valid ISO-8601 timestamp', 'timestamp.preservedAt');
  }
}

function validateSnapshotReason(reason) {
  assert(isPlainObject(reason), 'SnapshotReason must be an object', 'reason');
  assert(isNonEmptyString(reason.code), 'SnapshotReason.code must be a non-empty string', 'reason.code');
  if (reason.description !== undefined) {
    assert(isNonEmptyString(reason.description), 'SnapshotReason.description must be a non-empty string when present', 'reason.description');
  }
}

function validateSnapshotSource(source) {
  assert(isPlainObject(source), 'SnapshotSource must be an object', 'source');
  assert(isNonEmptyString(source.capability), 'SnapshotSource.capability must be a non-empty string', 'source.capability');
  if (source.eventId !== undefined) {
    assert(isNonEmptyString(source.eventId), 'SnapshotSource.eventId must be a non-empty string when present', 'source.eventId');
  }
}

function validateSnapshotConfidence(confidence) {
  assert(isPlainObject(confidence), 'SnapshotConfidence must be an object', 'confidence');
  assert(
    typeof confidence.score === 'number' && confidence.score >= 0 && confidence.score <= 1,
    'SnapshotConfidence.score must be a number between 0 and 1 inclusive',
    'confidence.score',
  );
  if (confidence.band !== undefined) {
    assert(['LOW', 'MEDIUM', 'HIGH'].includes(confidence.band), 'SnapshotConfidence.band must be LOW, MEDIUM, or HIGH', 'confidence.band');
  }
}

function validateSnapshotTrigger(trigger) {
  assert(isPlainObject(trigger), 'SnapshotTrigger must be an object', 'trigger');
  assert(isEnumMember(SnapshotOrigin, trigger.origin), 'SnapshotTrigger.origin must be a valid SnapshotOrigin', 'trigger.origin');
  if (trigger.triggerId !== undefined) {
    assert(isNonEmptyString(trigger.triggerId), 'SnapshotTrigger.triggerId must be a non-empty string when present', 'trigger.triggerId');
  }
}

function validateSnapshotScope(v) {
  assert(isNonEmptyString(v), 'SnapshotScope must be a non-empty string', 'scope');
}

function validateSnapshotStatus(v) {
  if (v === undefined) return;
  assert(isNonEmptyString(v), 'SnapshotStatus must be a non-empty string when present', 'status');
}

function validateContextScope(scope) {
  assert(isPlainObject(scope), 'ContextScope must be an object', 'context.scope');
  assert(isEnumMember(ContextType, scope.type), 'ContextScope.type must be a valid ContextType', 'context.scope.type');
  assert(isArray(scope.domains) && scope.domains.every(isNonEmptyString), 'ContextScope.domains must be an array of non-empty strings', 'context.scope.domains');
}

function validateEvidenceReference(ref) {
  assert(isPlainObject(ref), 'EvidenceReference must be an object', 'evidence[]');
  assert(isEnumMember(EvidenceType, ref.evidenceType), 'EvidenceReference.evidenceType must be a valid EvidenceType', 'evidence[].evidenceType');
  assert(isNonEmptyString(ref.referenceId), 'EvidenceReference.referenceId must be a non-empty string', 'evidence[].referenceId');
  assert(isNonEmptyString(ref.sourceCapability), 'EvidenceReference.sourceCapability must be a non-empty string', 'evidence[].sourceCapability');
}

function validateSignalReference(ref) {
  assert(isPlainObject(ref), 'SignalReference must be an object', 'sourceSignals[]');
  assert(isEnumMember(SignalType, ref.signalType), 'SignalReference.signalType must be a valid SignalType', 'sourceSignals[].signalType');
  assert(isNonEmptyString(ref.referenceId), 'SignalReference.referenceId must be a non-empty string', 'sourceSignals[].referenceId');
}

function validateDomainReference(ref) {
  assert(isPlainObject(ref), 'DomainReference must be an object', 'domainReference');
  assert(isNonEmptyString(ref.domainName), 'DomainReference.domainName must be a non-empty string', 'domainReference.domainName');
}

function validateRelationshipReference(ref) {
  assert(isPlainObject(ref), 'RelationshipReference must be an object', 'relationshipReference');
  assert(
    ['SNAPSHOT', 'MOMENT', 'CONTEXT_ENVELOPE'].includes(ref.targetType),
    'RelationshipReference.targetType must be SNAPSHOT, MOMENT, or CONTEXT_ENVELOPE',
    'relationshipReference.targetType',
  );
  assert(isNonEmptyString(ref.targetId), 'RelationshipReference.targetId must be a non-empty string', 'relationshipReference.targetId');
}

function validateVersionReference(ref) {
  assert(isPlainObject(ref), 'VersionReference must be an object', 'versionReference');
  assert(isNonEmptyString(ref.snapshotId), 'VersionReference.snapshotId must be a non-empty string', 'versionReference.snapshotId');
  assert(Number.isInteger(ref.version) && ref.version >= 1, 'VersionReference.version must be an integer >= 1', 'versionReference.version');
}

// ─────────────────────────────────────────────────────────────────────────
// ENTITIES
// ─────────────────────────────────────────────────────────────────────────

function validateSnapshotVersion(v) {
  assert(isPlainObject(v), 'SnapshotVersion must be an object', 'version');
  assert(Number.isInteger(v.version) && v.version >= 1, 'SnapshotVersion.version must be an integer >= 1', 'version.version');
  if (v.supersedes !== undefined) {
    validateSnapshotIdentifier(v.supersedes);
  }
}

function validateSnapshotState(state) {
  assert(isPlainObject(state), 'SnapshotState must be an object', 'state');
  assert(isPlainObject(state.observedFields), 'SnapshotState.observedFields must be an object', 'state.observedFields');
  assert(isArray(state.sourceSignals), 'SnapshotState.sourceSignals must be an array', 'state.sourceSignals');
  state.sourceSignals.forEach(validateSignalReference);
}

function validateSnapshotMetadata(metadata) {
  assert(isPlainObject(metadata), 'SnapshotMetadata must be an object', 'metadata');
  assert(isIsoTimestamp(metadata.createdAt), 'SnapshotMetadata.createdAt must be a valid ISO-8601 timestamp', 'metadata.createdAt');
  assert(isIsoTimestamp(metadata.preservedAt), 'SnapshotMetadata.preservedAt must be a valid ISO-8601 timestamp', 'metadata.preservedAt');
  assert(isEnumMember(SnapshotOrigin, metadata.origin), 'SnapshotMetadata.origin must be a valid SnapshotOrigin', 'metadata.origin');
  assert(isEnumMember(SnapshotVisibility, metadata.visibility), 'SnapshotMetadata.visibility must be a valid SnapshotVisibility', 'metadata.visibility');
  assert(isEnumMember(SnapshotRetentionPolicy, metadata.retentionPolicy), 'SnapshotMetadata.retentionPolicy must be a valid SnapshotRetentionPolicy', 'metadata.retentionPolicy');
  assert(isEnumMember(SnapshotConsistencyState, metadata.consistencyState), 'SnapshotMetadata.consistencyState must be a valid SnapshotConsistencyState', 'metadata.consistencyState');
}

function validateSnapshotEvidenceReference(v) {
  assert(isPlainObject(v), 'SnapshotEvidenceReference must be an object', 'evidenceReference');
  assert(isArray(v.evidence), 'SnapshotEvidenceReference.evidence must be an array', 'evidenceReference.evidence');
  v.evidence.forEach(validateEvidenceReference);
  const ids = v.evidence.map((e) => e.referenceId);
  assert(new Set(ids).size === ids.length, 'SnapshotEvidenceReference.evidence must not contain duplicate referenceId values', 'evidenceReference.evidence');
}

function validateEvolutionReference(v) {
  assert(isPlainObject(v), 'EvolutionReference must be an object', 'evolutionReference');
  validateVersionReference(v.from);
  validateVersionReference(v.to);
  if (v.evolutionId !== undefined) {
    assert(isNonEmptyString(v.evolutionId), 'EvolutionReference.evolutionId must be a non-empty string when present', 'evolutionReference.evolutionId');
  }
}

function validateNarrativeReference(v) {
  assert(isPlainObject(v), 'NarrativeReference must be an object', 'narrativeReference');
  assert(isArray(v.coversVersions) && v.coversVersions.length > 0, 'NarrativeReference.coversVersions must be a non-empty array', 'narrativeReference.coversVersions');
  v.coversVersions.forEach(validateVersionReference);
  if (v.narrativeId !== undefined) {
    assert(isNonEmptyString(v.narrativeId), 'NarrativeReference.narrativeId must be a non-empty string when present', 'narrativeReference.narrativeId');
  }
}

function validateExplanationReference(v) {
  assert(isPlainObject(v), 'ExplanationReference must be an object', 'explanationReference');
  assert(isArray(v.groundedIn) && v.groundedIn.length > 0, 'ExplanationReference.groundedIn must be a non-empty array', 'explanationReference.groundedIn');
  v.groundedIn.forEach(validateSnapshotIdentifier);
  if (v.evolution !== undefined) {
    validateEvolutionReference(v.evolution);
  }
}

function validateGovernanceEvidenceReference(v) {
  assert(isPlainObject(v), 'GovernanceEvidenceReference must be an object', 'governanceEvidenceReference');
  assert(isArray(v.groundedIn) && v.groundedIn.length > 0, 'GovernanceEvidenceReference.groundedIn must be a non-empty array', 'governanceEvidenceReference.groundedIn');
  v.groundedIn.forEach(validateSnapshotIdentifier);
}

function validateMoment(moment) {
  assert(isPlainObject(moment), 'Moment must be an object', 'moment');
  validateMomentIdentifier(moment.id);
  validateSubjectReference(moment.subject);
  validateMomentType(moment.momentType);
  validateMomentCategory(moment.momentCategory);
  assert(isEnumMember(MomentClassification, moment.classification), 'Moment.classification must be a valid MomentClassification', 'moment.classification');
  validateSnapshotTimestamp(moment.timestamp);
  validateSnapshotReason(moment.reason);
}

function validateContextEnvelope(envelope) {
  assert(isPlainObject(envelope), 'ContextEnvelope must be an object', 'context');
  assert(isNonEmptyString(envelope.id), 'ContextEnvelope.id must be a non-empty string', 'context.id');
  validateMomentIdentifier(envelope.momentId);
  validateContextScope(envelope.scope);
  validateSnapshotEvidenceReference(envelope.evidence);
}

function validateSnapshot(snapshot) {
  assert(isPlainObject(snapshot), 'Snapshot must be an object', 'snapshot');
  validateSnapshotIdentifier(snapshot.id);
  validateSubjectReference(snapshot.subject);
  validateSnapshotScope(snapshot.scope);
  validateMoment(snapshot.moment);
  validateContextEnvelope(snapshot.context);
  validateSnapshotVersion(snapshot.version);
  validateSnapshotState(snapshot.state);
  validateSnapshotSource(snapshot.source);
  if (snapshot.confidence !== undefined) {
    validateSnapshotConfidence(snapshot.confidence);
  }
  validateSnapshotTrigger(snapshot.trigger);
  validateSnapshotStatus(snapshot.status);
  assert(isEnumMember(SnapshotLifecycle, snapshot.lifecycle), 'Snapshot.lifecycle must be a valid SnapshotLifecycle', 'snapshot.lifecycle');
  assert(
    isEnumMember(SnapshotSupersessionState, snapshot.supersessionState),
    'Snapshot.supersessionState must be a valid SnapshotSupersessionState',
    'snapshot.supersessionState',
  );
  validateSnapshotMetadata(snapshot.metadata);

  // Cross-field invariant: a snapshot's subject must match its moment's subject.
  assert(
    snapshot.subject.subjectType === snapshot.moment.subject.subjectType
      && snapshot.subject.subjectId === snapshot.moment.subject.subjectId,
    'Snapshot.subject must match Snapshot.moment.subject',
    'snapshot.subject',
  );

  // Cross-field invariant: a snapshot's context must reference its own moment.
  assert(
    snapshot.context.momentId === snapshot.moment.id,
    'Snapshot.context.momentId must match Snapshot.moment.id',
    'snapshot.context.momentId',
  );
}

module.exports = {
  // primitives (exported for reuse/testing only; not part of the public contract)
  isNonEmptyString,
  isPlainObject,
  isArray,
  isIsoTimestamp,
  isEnumMember,
  // identifiers & references
  validateSnapshotIdentifier,
  validateMomentIdentifier,
  validateSubjectReference,
  // value objects
  validateMomentType,
  validateMomentCategory,
  validateSnapshotTimestamp,
  validateSnapshotReason,
  validateSnapshotSource,
  validateSnapshotConfidence,
  validateSnapshotTrigger,
  validateSnapshotScope,
  validateSnapshotStatus,
  validateContextScope,
  validateEvidenceReference,
  validateSignalReference,
  validateDomainReference,
  validateRelationshipReference,
  validateVersionReference,
  // entities
  validateSnapshotVersion,
  validateSnapshotState,
  validateSnapshotMetadata,
  validateSnapshotEvidenceReference,
  validateEvolutionReference,
  validateNarrativeReference,
  validateExplanationReference,
  validateGovernanceEvidenceReference,
  validateMoment,
  validateContextEnvelope,
  validateSnapshot,
};
