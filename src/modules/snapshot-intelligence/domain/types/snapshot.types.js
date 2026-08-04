'use strict';

/**
 * @file core-work/src/modules/snapshot-intelligence/domain/types/snapshot.types.js
 *
 * KR-02A — Snapshot Domain Foundation
 *
 * JSDoc-only type definitions for the canonical Snapshot Intelligence
 * domain, following this repository's existing convention (per
 * src/domain/studentProfile/studentProfile.types.js): no dedicated
 * TypeScript types, JSDoc typedefs centralized in one file so every
 * entity, value-object, and contract module can
 * `@typedef {import('./snapshot.types').X}` instead of repeating a shape.
 *
 * This file exports nothing at runtime — it exists purely for IDE/JSDoc
 * tooling. `module.exports = {}` is present only so `require()` does not
 * error if a file requires it by convention.
 *
 * Every type below is a domain contract, not a persistence shape — there
 * is no column, table, or SQL type implied here (KR-02A does not
 * implement persistence; see KR-02B).
 */

// ─────────────────────────────────────────────────────────────────────────
// IDENTIFIERS
// ─────────────────────────────────────────────────────────────────────────

/**
 * @typedef {string} SnapshotIdentifier - Opaque, globally unique identifier
 * for a single preserved Snapshot record.
 */

/**
 * @typedef {string} MomentIdentifier - Opaque, globally unique identifier
 * for a single recognized Moment (may be referenced by more than one
 * Snapshot if the moment is later re-preserved with additional context).
 */

/**
 * @typedef {Object} SubjectReference - Points at the student or
 * professional the snapshot's history belongs to, without Snapshot
 * Intelligence owning or duplicating that subject's current-state record
 * (KR-01B's No Current-State Ownership principle).
 * @property {'STUDENT'|'PROFESSIONAL'} subjectType
 * @property {string} subjectId - id in the certified Student Repository or
 * Professional Repository; never copied or mirrored, only referenced.
 */

// ─────────────────────────────────────────────────────────────────────────
// VALUE OBJECTS
// ─────────────────────────────────────────────────────────────────────────

/**
 * @typedef {string} MomentType - Free-form, validated label naming the
 * kind of moment recognized (e.g. "resume-updated", "chi-score-crossed-
 * threshold"). Distinct from MomentClassification (snapshot.constants.js),
 * which is the closed enumeration this label is expected to map to.
 */

/**
 * @typedef {string} MomentCategory - Validated grouping label for related
 * MomentTypes (e.g. multiple resume-related MomentTypes share the
 * "resume" MomentCategory). Used for retrieval/filtering, not for
 * interpretation logic (which belongs to KR-02C).
 */

/**
 * @typedef {Object} SnapshotTimestamp - The point in time a moment
 * occurred, kept distinct from the point in time it was preserved
 * (`preservedAt` on SnapshotMetadata), since the two can differ under the
 * scheduled-consistency-sweep path (KR-02 §10.3).
 * @property {string} occurredAt - ISO-8601 timestamp
 * @property {string} [preservedAt] - ISO-8601 timestamp; set by
 * SnapshotMetadata, duplicated here read-only for convenience in display
 * contexts. Never authoritative — SnapshotMetadata.preservedAt is.
 */

/**
 * @typedef {Object} SnapshotReason - Why this snapshot was created.
 * @property {string} code - short, validated reason code
 * @property {string} [description] - human-readable elaboration
 */

/**
 * @typedef {Object} SnapshotSource - Which upstream certified capability
 * produced the signal(s) that led to this snapshot.
 * @property {string} capability - name of the upstream certified
 * capability (e.g. "Resume Intelligence"); must be one of the
 * capabilities listed in KR-02-R1 §2 as production-certified
 * infrastructure.
 * @property {string} [eventId] - id of the KR-02 §10 consumer event, if
 * this snapshot originated from the event-driven path.
 */

/**
 * @typedef {Object} SnapshotConfidence - Confidence in the recognized
 * moment, disclosed as a simple 0–1 scalar plus an optional qualitative
 * band; KR-02A defines the shape only; KR-02C computes the value.
 * @property {number} score - 0.0–1.0 inclusive
 * @property {'LOW'|'MEDIUM'|'HIGH'} [band]
 */

/**
 * @typedef {Object} SnapshotTrigger - What caused recalculation/creation.
 * @property {import('./snapshot.types').SnapshotOrigin} origin
 * @property {string} [triggerId] - correlates to the KR-02 §10 event or
 * scheduled-sweep run that caused this snapshot
 */

/**
 * @typedef {string} SnapshotScope - Validated label describing which
 * subdomain of the subject's profile this snapshot's Moment concerns
 * (e.g. "career-readiness", "resume", "profile-completion").
 */

/**
 * @typedef {string} SnapshotStatus - Free-form, validated status label,
 * distinct from the closed SnapshotLifecycle enumeration; used for
 * finer-grained, non-authoritative display status where a work package
 * downstream of KR-02A needs one without this work package anticipating
 * every future value.
 */

/**
 * @typedef {Object} ContextScope - Boundary of what a ContextEnvelope's
 * preserved context covers.
 * @property {import('./snapshot.types').ContextType} type
 * @property {string[]} domains - validated list of SnapshotScope values
 * this context envelope's evidence pertains to
 */

/**
 * @typedef {Object} EvidenceReference - Pointer to a single piece of
 * evidence backing a preserved moment's context, never a copy of the
 * evidence itself (KR-01B: no duplication of upstream business logic or
 * data).
 * @property {import('./snapshot.types').EvidenceType} evidenceType
 * @property {string} referenceId - opaque id resolvable in the owning
 * upstream capability
 * @property {string} sourceCapability
 */

/**
 * @typedef {Object} SignalReference - Pointer to a single upstream signal
 * value observed at moment-recognition time, never a copy of the
 * signal's owning record.
 * @property {import('./snapshot.types').SignalType} signalType
 * @property {string} referenceId
 * @property {*} [observedValue] - the value as observed, preserved
 * verbatim; Snapshot Intelligence does not reinterpret it at capture time
 */

/**
 * @typedef {Object} DomainReference - Pointer to one of KR-01C's
 * conceptual domains that a given artifact (entity, contract, or test)
 * implements, used only by the Architecture Traceability Matrix and by
 * documentation tooling — never evaluated at runtime.
 * @property {string} domainName
 */

/**
 * @typedef {Object} RelationshipReference - Pointer from one Snapshot
 * Intelligence entity to another (e.g. a NarrativeReference pointing at
 * the ordered Snapshots it narrates), kept as an id reference rather than
 * a nested object so entities remain independently serializable.
 * @property {'SNAPSHOT'|'MOMENT'|'CONTEXT_ENVELOPE'} targetType
 * @property {string} targetId
 */

/**
 * @typedef {Object} VersionReference - Pointer to a specific
 * SnapshotVersion, used by EvolutionReference and NarrativeReference to
 * name which versions of a snapshot they were computed against.
 * @property {string} snapshotId
 * @property {number} version
 */

// ─────────────────────────────────────────────────────────────────────────
// ENTITIES
// ─────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} SnapshotVersion - Monotonically increasing version
 * counter for a logical snapshot lineage (a subject's sequence of
 * preserved states for one SnapshotScope). A new version is created, not
 * an existing one mutated, whenever the subject's state is re-preserved.
 * @property {number} version - starts at 1
 * @property {import('./snapshot.types').SnapshotIdentifier} [supersedes] -
 * the immediately prior SnapshotIdentifier in this lineage, if any
 */

/**
 * @typedef {Object} SnapshotState - The preserved subject state itself:
 * an opaque, capability-agnostic bag of observed field values. KR-02A
 * defines only the envelope shape; it is Moment Recognition (KR-02C)
 * that decides which upstream fields populate `observedFields`, and
 * Snapshot Intelligence never reinterprets or recomputes them.
 * @property {Object<string, *>} observedFields - verbatim, as-observed
 * key/value pairs; never derived or recomputed by this domain
 * @property {import('./snapshot.types').SignalReference[]} sourceSignals
 */

/**
 * @typedef {Object} SnapshotMetadata - Non-business-meaning bookkeeping
 * fields every Snapshot carries, kept in its own value object so entity
 * definitions stay focused on domain meaning.
 * @property {string} createdAt - ISO-8601 timestamp; immutable once set
 * @property {string} preservedAt - ISO-8601 timestamp of preservation
 * (may lag createdAt under the scheduled-sweep path)
 * @property {import('./snapshot.types').SnapshotOrigin} origin
 * @property {import('./snapshot.types').SnapshotVisibility} visibility
 * @property {import('./snapshot.types').SnapshotRetentionPolicy} retentionPolicy
 * @property {import('./snapshot.types').SnapshotConsistencyState} consistencyState
 */

/**
 * @typedef {Object} SnapshotEvidenceReference - Top-level list of evidence
 * a Snapshot's Context Envelope is built from; a thin, ordered collection
 * of EvidenceReference used by Governance Evidence Provision (KR-02F) and
 * validated for uniqueness by KR-02A's schema layer.
 * @property {import('./snapshot.types').EvidenceReference[]} evidence
 */

/**
 * @typedef {Object} EvolutionReference - Pointer to an Evolution
 * Interpretation result (computed by KR-02C) describing the shape of
 * change between two VersionReferences. KR-02A defines only the
 * reference shape; it never computes or stores the interpretation
 * result itself.
 * @property {import('./snapshot.types').VersionReference} from
 * @property {import('./snapshot.types').VersionReference} to
 * @property {string} [evolutionId] - opaque id of the computed
 * interpretation result, owned by KR-02C
 */

/**
 * @typedef {Object} NarrativeReference - Pointer to a composed narrative
 * (produced by Narrative Composition, KR-02F) describing the ordered
 * Snapshots it was composed from. KR-02A defines only the reference
 * shape.
 * @property {import('./snapshot.types').VersionReference[]} coversVersions
 * @property {string} [narrativeId] - opaque id of the composed narrative,
 * owned by KR-02F
 */

/**
 * @typedef {Object} ExplanationReference - Pointer to an explanation
 * (produced by Explainability Delivery, KR-02F) grounded in one or more
 * Snapshots and, optionally, an EvolutionReference.
 * @property {import('./snapshot.types').SnapshotIdentifier[]} groundedIn
 * @property {import('./snapshot.types').EvolutionReference} [evolution]
 * @property {string} [explanationId] - opaque id owned by KR-02F
 */

/**
 * @typedef {Object} GovernanceEvidenceReference - Pointer to a governance
 * evidence package (produced by Governance Evidence Provision, KR-02F)
 * assembled from one or more Snapshots and their Context Envelopes.
 * @property {import('./snapshot.types').SnapshotIdentifier[]} groundedIn
 * @property {string} [evidencePackageId] - opaque id owned by KR-02F
 */

/**
 * @typedef {Object} Moment - The recognized, meaningful point in a
 * subject's career profile that a Snapshot preserves. Immutable once
 * constructed (KR-01B's Historical Truth principle).
 * @property {import('./snapshot.types').MomentIdentifier} id
 * @property {import('./snapshot.types').SubjectReference} subject
 * @property {import('./snapshot.types').MomentType} momentType
 * @property {import('./snapshot.types').MomentCategory} momentCategory
 * @property {import('../constants/snapshot.constants').MomentClassification[keyof import('../constants/snapshot.constants').MomentClassification]} classification
 * @property {import('./snapshot.types').SnapshotTimestamp} timestamp
 * @property {import('./snapshot.types').SnapshotReason} reason
 */

/**
 * @typedef {Object} ContextEnvelope - The reasoning and evidence behind a
 * preserved Moment, per KR-01B's Context Preservation capability.
 * Immutable once constructed.
 * @property {string} id - opaque ContextEnvelope identifier
 * @property {import('./snapshot.types').MomentIdentifier} momentId
 * @property {import('./snapshot.types').ContextScope} scope
 * @property {import('./snapshot.types').SnapshotEvidenceReference} evidence
 */

/**
 * @typedef {Object} Snapshot - The canonical preserved-moment record;
 * the aggregate root of the Snapshot Intelligence domain. Immutable once
 * constructed; a change in subject state produces a new Snapshot with an
 * incremented SnapshotVersion, never a mutation of an existing one.
 * @property {import('./snapshot.types').SnapshotIdentifier} id
 * @property {import('./snapshot.types').SubjectReference} subject
 * @property {import('./snapshot.types').SnapshotScope} scope
 * @property {import('./snapshot.types').Moment} moment
 * @property {import('./snapshot.types').ContextEnvelope} context
 * @property {import('./snapshot.types').SnapshotVersion} version
 * @property {import('./snapshot.types').SnapshotState} state
 * @property {import('./snapshot.types').SnapshotSource} source
 * @property {import('./snapshot.types').SnapshotConfidence} [confidence]
 * @property {import('./snapshot.types').SnapshotTrigger} trigger
 * @property {import('./snapshot.types').SnapshotStatus} [status]
 * @property {import('../constants/snapshot.constants').SnapshotLifecycle[keyof import('../constants/snapshot.constants').SnapshotLifecycle]} lifecycle
 * @property {import('../constants/snapshot.constants').SnapshotSupersessionState[keyof import('../constants/snapshot.constants').SnapshotSupersessionState]} supersessionState
 * @property {import('./snapshot.types').SnapshotMetadata} metadata
 */

module.exports = {};
