'use strict';

/**
 * @file core-work/src/modules/snapshot-intelligence/domain/schemas/snapshot.schema.js
 *
 * KR-02A — Snapshot Domain Foundation
 *
 * A single registry mapping every domain type name to its validator
 * (from snapshot.validation.js) and to the KR-01C conceptual domain it
 * implements. This is consumed by:
 *   - snapshot.naming.test.js, which asserts every entity/value-object
 *     factory in this module has a corresponding, identically-named
 *     validator and registry entry (no naming drift between the three)
 *   - the Architecture Traceability Matrix (KR-02A deliverable #10),
 *     which is generated from this registry rather than hand-maintained
 *     separately, so the matrix cannot silently fall out of sync with
 *     the code
 *
 * This file contains no validation logic of its own — it only wires
 * together what snapshot.validation.js already defines.
 */

const validation = require('./snapshot.validation');

/**
 * @typedef {Object} SchemaRegistryEntry
 * @property {'entity'|'value-object'} kind
 * @property {Function} validate
 * @property {string} domainReference - the KR-01C conceptual domain (or
 * KR-01B capability, for cross-cutting types) this artifact implements
 */

/** @type {Object<string, SchemaRegistryEntry>} */
const SCHEMA_REGISTRY = Object.freeze({
  // Identifiers & references
  SnapshotIdentifier: { kind: 'entity', validate: validation.validateSnapshotIdentifier, domainReference: 'Historical Preservation' },
  MomentIdentifier: { kind: 'entity', validate: validation.validateMomentIdentifier, domainReference: 'Moment Recognition' },
  SubjectReference: { kind: 'entity', validate: validation.validateSubjectReference, domainReference: 'No Current-State Ownership' },

  // Value objects
  MomentType: { kind: 'value-object', validate: validation.validateMomentType, domainReference: 'Moment Recognition' },
  MomentCategory: { kind: 'value-object', validate: validation.validateMomentCategory, domainReference: 'Moment Recognition' },
  SnapshotTimestamp: { kind: 'value-object', validate: validation.validateSnapshotTimestamp, domainReference: 'Historical Preservation' },
  SnapshotReason: { kind: 'value-object', validate: validation.validateSnapshotReason, domainReference: 'Historical Preservation' },
  SnapshotSource: { kind: 'value-object', validate: validation.validateSnapshotSource, domainReference: 'Context Preservation' },
  SnapshotConfidence: { kind: 'value-object', validate: validation.validateSnapshotConfidence, domainReference: 'Moment Recognition' },
  SnapshotTrigger: { kind: 'value-object', validate: validation.validateSnapshotTrigger, domainReference: 'Evolution Interpretation' },
  SnapshotScope: { kind: 'value-object', validate: validation.validateSnapshotScope, domainReference: 'Historical Preservation' },
  SnapshotStatus: { kind: 'value-object', validate: validation.validateSnapshotStatus, domainReference: 'Historical Preservation' },
  ContextScope: { kind: 'value-object', validate: validation.validateContextScope, domainReference: 'Context Preservation' },
  EvidenceReference: { kind: 'value-object', validate: validation.validateEvidenceReference, domainReference: 'Context Preservation' },
  SignalReference: { kind: 'value-object', validate: validation.validateSignalReference, domainReference: 'Context Preservation' },
  DomainReference: { kind: 'value-object', validate: validation.validateDomainReference, domainReference: 'Governance Evidence Provision' },
  RelationshipReference: { kind: 'value-object', validate: validation.validateRelationshipReference, domainReference: 'Historical Preservation' },
  VersionReference: { kind: 'value-object', validate: validation.validateVersionReference, domainReference: 'Evolution Interpretation' },

  // Entities
  SnapshotVersion: { kind: 'entity', validate: validation.validateSnapshotVersion, domainReference: 'Historical Preservation' },
  SnapshotState: { kind: 'entity', validate: validation.validateSnapshotState, domainReference: 'Historical Preservation' },
  SnapshotMetadata: { kind: 'entity', validate: validation.validateSnapshotMetadata, domainReference: 'Governance Evidence Provision' },
  SnapshotEvidenceReference: { kind: 'entity', validate: validation.validateSnapshotEvidenceReference, domainReference: 'Context Preservation' },
  EvolutionReference: { kind: 'entity', validate: validation.validateEvolutionReference, domainReference: 'Evolution Interpretation' },
  NarrativeReference: { kind: 'entity', validate: validation.validateNarrativeReference, domainReference: 'Narrative Composition' },
  ExplanationReference: { kind: 'entity', validate: validation.validateExplanationReference, domainReference: 'Explainability Delivery' },
  GovernanceEvidenceReference: { kind: 'entity', validate: validation.validateGovernanceEvidenceReference, domainReference: 'Governance Evidence Provision' },
  Moment: { kind: 'entity', validate: validation.validateMoment, domainReference: 'Moment Recognition' },
  ContextEnvelope: { kind: 'entity', validate: validation.validateContextEnvelope, domainReference: 'Context Preservation' },
  Snapshot: { kind: 'entity', validate: validation.validateSnapshot, domainReference: 'Historical Preservation' },
});

module.exports = {
  SCHEMA_REGISTRY,
};
