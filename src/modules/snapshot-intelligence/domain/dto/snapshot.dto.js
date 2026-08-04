'use strict';

/**
 * @file core-work/src/modules/snapshot-intelligence/domain/dto/snapshot.dto.js
 *
 * KR-02A — Snapshot Domain Foundation
 *
 * Canonical DTOs and read models, per KR-02A's "Shared Contracts" ›
 * "Canonical DTOs" / "Read Models" deliverable.
 *
 * A DTO here is a plain-object serialization of a domain entity, safe to
 * pass across a process boundary (HTTP response, event payload, worker
 * message) — it is derived from an entity, never constructed directly,
 * and it never carries more information than the entity it was built
 * from. KR-02A defines the mapping functions only; no boundary (API,
 * worker, event bus) actually calls them yet — that begins in KR-02D
 * through KR-02G.
 *
 * A read model here is a DTO shaped for a specific consumption pattern
 * (e.g. a comparison read model pairs two SnapshotDTOs) rather than a
 * one-to-one entity mirror. KR-02A defines the shape only; KR-02E is
 * where a real query populates one.
 *
 * These functions are pure and perform no validation of their own —
 * they operate on values that are already-validated domain entities
 * (see ../entities/snapshot.entities.js), so re-validating here would be
 * redundant. If passed a non-entity, behavior is undefined; callers are
 * expected to only pass entities constructed via the entity factories.
 */

/**
 * @typedef {Object} SnapshotDTO
 * @property {string} id
 * @property {import('../types/snapshot.types').SubjectReference} subject
 * @property {string} scope
 * @property {Object} moment - serialized Moment
 * @property {Object} context - serialized ContextEnvelope
 * @property {number} version
 * @property {string} lifecycle
 * @property {string} supersessionState
 * @property {string} createdAt
 * @property {string} preservedAt
 */

/**
 * Maps a Snapshot entity to its canonical DTO shape.
 *
 * @param {import('../types/snapshot.types').Snapshot} snapshot
 * @returns {SnapshotDTO}
 */
function toSnapshotDTO(snapshot) {
  return {
    id: snapshot.id,
    subject: snapshot.subject,
    scope: snapshot.scope,
    moment: {
      id: snapshot.moment.id,
      momentType: snapshot.moment.momentType,
      momentCategory: snapshot.moment.momentCategory,
      classification: snapshot.moment.classification,
      timestamp: snapshot.moment.timestamp,
      reason: snapshot.moment.reason,
    },
    context: {
      id: snapshot.context.id,
      scope: snapshot.context.scope,
      evidenceCount: snapshot.context.evidence.evidence.length,
    },
    version: snapshot.version.version,
    lifecycle: snapshot.lifecycle,
    supersessionState: snapshot.supersessionState,
    createdAt: snapshot.metadata.createdAt,
    preservedAt: snapshot.metadata.preservedAt,
  };
}

/**
 * Maps a Snapshot entity to a minimal, list-view read model — deliberately
 * thinner than SnapshotDTO for retrieval endpoints that list many
 * snapshots at once (KR-02E's list endpoint). Excludes context and full
 * moment detail.
 *
 * @param {import('../types/snapshot.types').Snapshot} snapshot
 * @returns {{id: string, scope: string, momentType: string, version: number, occurredAt: string, supersessionState: string}}
 */
function toSnapshotListItemReadModel(snapshot) {
  return {
    id: snapshot.id,
    scope: snapshot.scope,
    momentType: snapshot.moment.momentType,
    version: snapshot.version.version,
    occurredAt: snapshot.moment.timestamp.occurredAt,
    supersessionState: snapshot.supersessionState,
  };
}

/**
 * Pairs two SnapshotDTOs into the comparison read model KR-02E's
 * comparison endpoint will return. KR-02A defines the shape only — no
 * Evolution Interpretation output is attached here; that is KR-02C/KR-02F.
 *
 * @param {import('../types/snapshot.types').Snapshot} fromSnapshot
 * @param {import('../types/snapshot.types').Snapshot} toSnapshot
 * @returns {{from: SnapshotDTO, to: SnapshotDTO}}
 */
function toSnapshotComparisonReadModel(fromSnapshot, toSnapshot) {
  return {
    from: toSnapshotDTO(fromSnapshot),
    to: toSnapshotDTO(toSnapshot),
  };
}

module.exports = {
  toSnapshotDTO,
  toSnapshotListItemReadModel,
  toSnapshotComparisonReadModel,
};
