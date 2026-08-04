'use strict';

/**
 * @file core-work/src/modules/snapshot-intelligence/domain/contracts/snapshot.contracts.js
 *
 * KR-02A — Snapshot Domain Foundation
 *
 * Shared contracts, per KR-02A's "Shared Contracts" deliverable. Where
 * "Canonical DTOs" and "Read Models" and "Event Payload Contracts" have
 * their own dedicated files (../dto/snapshot.dto.js,
 * ../events/snapshot.eventContracts.js), this file holds the remaining
 * four contract categories KR-02A calls for:
 *
 *   - Internal Contracts   — in-process function signatures later work
 *                             packages must implement (KR-02C, KR-02F)
 *   - Public Contracts      — the API-ready response envelope shape
 *                             KR-02E's controllers will populate
 *   - Worker Contracts       — the job-handler signature KR-02G's
 *                             snapshot-worker must implement
 *   - Repository Contracts   — the persistence-interface signature
 *                             KR-02B's repository must implement
 *
 * Every contract below is a JSDoc-documented interface, not a running
 * implementation — KR-02A implements no persistence, computation, API,
 * or worker code (see this work package's Constraints). A later work
 * package that implements one of these interfaces is expected to
 * `@implements` or otherwise reference the corresponding typedef so the
 * connection is traceable (see the Architecture Traceability Matrix).
 *
 * CONTRACT_VERSIONS below gives every later work package a single place
 * to check contract compatibility rather than inferring it from shape.
 */

const CONTRACT_VERSIONS = Object.freeze({
  internal: 1,
  public: 1,
  worker: 1,
  repository: 1,
  event: 1,
  validation: 1,
});

// ─────────────────────────────────────────────────────────────────────────
// INTERNAL CONTRACTS — implemented by KR-02C, called by KR-02D/KR-02F/KR-02G
// ─────────────────────────────────────────────────────────────────────────

/**
 * @callback RecognizeMomentFn
 * @param {{subject: import('../types/snapshot.types').SubjectReference, scope: string, signals: import('../types/snapshot.types').SignalReference[]}} input
 * @returns {Promise<import('../types/snapshot.types').Moment|null>} - null
 * if no significant moment is recognized from the given signals
 */

/**
 * @callback RecalculateSnapshotFn
 * @param {{subject: import('../types/snapshot.types').SubjectReference, scope: string, trigger: import('../types/snapshot.types').SnapshotTrigger}} input
 * @returns {Promise<import('../types/snapshot.types').Snapshot>}
 */

// ─────────────────────────────────────────────────────────────────────────
// PUBLIC CONTRACTS — populated by KR-02E's api-service controllers
// ─────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} SnapshotApiEnvelope - the top-level response shape
 * every Snapshot Intelligence REST endpoint (KR-02 §9) is expected to
 * return, matching the response envelope convention already used
 * elsewhere in api-service.
 * @property {boolean} success
 * @property {*} data - a SnapshotDTO, an array of list-item read models,
 * or a comparison read model, depending on the endpoint
 * @property {{contractVersion: number}} meta
 */

// ─────────────────────────────────────────────────────────────────────────
// WORKER CONTRACTS — implemented by KR-02G's snapshot-worker service
// ─────────────────────────────────────────────────────────────────────────

/**
 * @callback SnapshotRecalculationJobHandler - the handler signature
 * snapshot-worker's event-triggered recalculation consumer (KR-02G) is
 * expected to implement, consuming the RecalculationCompletedEventPayload-
 * producing trigger described in KR-02 §9.3.
 * @param {{subject: import('../types/snapshot.types').SubjectReference, scope: string, triggerId: string}} job
 * @returns {Promise<void>}
 */

/**
 * @callback SnapshotConsistencySweepJobHandler - the handler signature
 * snapshot-worker's scheduled consistency-sweep job (KR-02G) is expected
 * to implement.
 * @param {{sweepStartedAt: string}} job
 * @returns {Promise<{subjectsSwept: number}>}
 */

// ─────────────────────────────────────────────────────────────────────────
// REPOSITORY CONTRACTS — implemented by KR-02B's SnapshotRepository
// ─────────────────────────────────────────────────────────────────────────

/**
 * @callback SnapshotRepositoryWrite
 * @param {import('../types/snapshot.types').Snapshot} snapshot
 * @returns {Promise<void>} - must be idempotent under replay of the same
 * SnapshotIdentifier (KR-02 §6, KR-02B exit criteria)
 */

/**
 * @callback SnapshotRepositoryFindById
 * @param {import('../types/snapshot.types').SnapshotIdentifier} id
 * @returns {Promise<import('../types/snapshot.types').Snapshot|null>}
 */

/**
 * @callback SnapshotRepositoryFindLatest
 * @param {import('../types/snapshot.types').SubjectReference} subject
 * @param {string} scope
 * @returns {Promise<import('../types/snapshot.types').Snapshot|null>} -
 * must exclude snapshots whose supersessionState is SUPERSEDED
 */

/**
 * @callback SnapshotRepositoryListBySubject
 * @param {import('../types/snapshot.types').SubjectReference} subject
 * @param {string} [scope]
 * @returns {Promise<import('../types/snapshot.types').Snapshot[]>}
 */

/**
 * @typedef {Object} SnapshotRepositoryContract
 * @property {SnapshotRepositoryWrite} write
 * @property {SnapshotRepositoryFindById} findById
 * @property {SnapshotRepositoryFindLatest} findLatest
 * @property {SnapshotRepositoryListBySubject} listBySubject
 */

module.exports = {
  CONTRACT_VERSIONS,
};
