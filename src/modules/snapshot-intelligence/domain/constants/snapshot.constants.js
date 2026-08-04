'use strict';

/**
 * @file core-work/src/modules/snapshot-intelligence/domain/constants/snapshot.constants.js
 *
 * KR-02A — Snapshot Domain Foundation
 *
 * Canonical enumerations for the Snapshot Intelligence domain, per KR-02A's
 * "Enumerations" deliverable. Every enum is a frozen, string-keyed object —
 * the same "no magic strings" convention already used elsewhere in this
 * repository (e.g. shared/repositories, src/domain) — rather than a
 * TypeScript `enum` or a bare array, so callers get autocomplete and a
 * single place to change a member's wire value without touching every
 * call site.
 *
 * Architecture status: Frozen (KR-02-R1 §3). These enumerations implement
 * KR-01C's conceptual domain model; they do not introduce, redefine, or
 * extend any conceptual domain. Where KR-01C does not specify a concrete
 * set of values for a concept it names only conceptually, the value set
 * below is a disclosed implementation decision (see inline notes) and is
 * intentionally the smallest set that satisfies KR-01B's capability
 * responsibilities — additional members can be appended in a later work
 * package without this being an architectural change, since the concept
 * itself is not being redefined.
 *
 * No business logic lives in this file. No I/O. No dependencies.
 */

/**
 * How a preserved Moment is classified by Moment Recognition (KR-01B
 * capability). Disclosed decision: KR-01C does not enumerate concrete
 * classification values, so this is the minimal set implied by KR-01B's
 * capability descriptions (a moment can reflect an achievement, a change
 * in trajectory, a milestone crossing, or a periodic checkpoint).
 */
const MomentClassification = Object.freeze({
  ACHIEVEMENT: 'ACHIEVEMENT',
  TRAJECTORY_SHIFT: 'TRAJECTORY_SHIFT',
  MILESTONE: 'MILESTONE',
  PERIODIC_CHECKPOINT: 'PERIODIC_CHECKPOINT',
});

/**
 * Lifecycle state of a Snapshot record, per KR-01B's Historical Truth and
 * Historical Preservation principles: a snapshot is written once (ACTIVE),
 * may later be superseded by a newer snapshot (SUPERSEDED), but is never
 * deleted or mutated in place.
 */
const SnapshotLifecycle = Object.freeze({
  ACTIVE: 'ACTIVE',
  SUPERSEDED: 'SUPERSEDED',
});

/**
 * Whether a snapshot has been superseded by a later one for the same
 * subject. Kept distinct from SnapshotLifecycle so that supersession can
 * be reasoned about independently of any future lifecycle states a later
 * work package might need to add (KR-02A does not anticipate what those
 * would be, and does not invent them here).
 */
const SnapshotSupersessionState = Object.freeze({
  CURRENT: 'CURRENT',
  SUPERSEDED: 'SUPERSEDED',
});

/**
 * What caused a Snapshot to be created. Distinguishes the event-driven
 * path from the scheduled-consistency-sweep path defined in KR-02 §10
 * (Event Architecture), so a governance evidence package (KR-02F) can
 * disclose which path produced a given record.
 */
const SnapshotOrigin = Object.freeze({
  EVENT_TRIGGERED: 'EVENT_TRIGGERED',
  SCHEDULED_SWEEP: 'SCHEDULED_SWEEP',
  MANUAL_BACKFILL: 'MANUAL_BACKFILL',
});

/**
 * Who/what a preserved snapshot is visible to. Disclosed decision, minimal
 * set: KR-01B positions Snapshot Intelligence as a foundational,
 * cross-cutting capability with governance characteristics, which implies
 * at least a subject-visible tier and a governance/audit-visible tier.
 */
const SnapshotVisibility = Object.freeze({
  SUBJECT: 'SUBJECT',
  INSTITUTION: 'INSTITUTION',
  GOVERNANCE: 'GOVERNANCE',
});

/**
 * Retention classification for a preserved snapshot. KR-01C's conceptual
 * information model calls for historical truth to be preserved, not for
 * how long — retention policy enforcement (if any) belongs to a later
 * work package. This enumeration only names the classification a
 * snapshot is tagged with; KR-02A implements no retention *logic*.
 */
const SnapshotRetentionPolicy = Object.freeze({
  STANDARD: 'STANDARD',
  EXTENDED_GOVERNANCE: 'EXTENDED_GOVERNANCE',
});

/**
 * Whether a snapshot's preserved state is known to be internally
 * consistent with the context it was preserved alongside. This is a
 * disclosed, minimal implementation of KR-01B's Evidence Before
 * Interpretation principle: a snapshot can be flagged as
 * UNDER_VERIFICATION before computation (KR-02C) has confirmed
 * consistency, without KR-02A implementing any verification logic itself.
 */
const SnapshotConsistencyState = Object.freeze({
  VERIFIED: 'VERIFIED',
  UNDER_VERIFICATION: 'UNDER_VERIFICATION',
  FLAGGED: 'FLAGGED',
});

/**
 * The category of context preserved alongside a Moment, per KR-01B's
 * Context Preservation capability.
 */
const ContextType = Object.freeze({
  SIGNAL_STATE: 'SIGNAL_STATE',
  DECISION_RATIONALE: 'DECISION_RATIONALE',
  UPSTREAM_EVENT: 'UPSTREAM_EVENT',
});

/**
 * The category of evidence a context envelope or governance evidence
 * package references.
 */
const EvidenceType = Object.freeze({
  SIGNAL_SNAPSHOT: 'SIGNAL_SNAPSHOT',
  UPSTREAM_RECORD_REFERENCE: 'UPSTREAM_RECORD_REFERENCE',
  RECOMMENDATION_RATIONALE: 'RECOMMENDATION_RATIONALE',
});

/**
 * The category of signal a SignalReference points to, mirroring the
 * upstream certified capabilities Snapshot Intelligence is allowed to
 * observe (KR-02-R1 §2) without owning.
 */
const SignalType = Object.freeze({
  CHI_SCORE: 'CHI_SCORE',
  CAREER_READINESS_SCORE: 'CAREER_READINESS_SCORE',
  PROFILE_FIELD: 'PROFILE_FIELD',
  RESUME_SIGNAL: 'RESUME_SIGNAL',
  KNOWLEDGE_RUNTIME_DECISION: 'KNOWLEDGE_RUNTIME_DECISION',
});

/**
 * Every enumeration this module exports, keyed by name, for generic
 * validation and documentation tooling (see snapshot.validation.js).
 */
const ALL_ENUMERATIONS = Object.freeze({
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
});

module.exports = {
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
  ALL_ENUMERATIONS,
};
