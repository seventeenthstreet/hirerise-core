'use strict';

/**
 * @file core/src/modules/snapshot-intelligence/repository/inMemory/InMemorySnapshotRepository.js
 *
 * KR-02B-01 — Snapshot Repository Foundation
 *
 * In-memory reference implementation of SnapshotRepository, per
 * KR-02B-01's "In-Memory Repository" deliverable: "This implementation
 * becomes the reference implementation for KR-02B."
 *
 * Zero infrastructure dependencies — the entire store is a single
 * in-process Map, per KR-02B-01's Objective ("execute entirely using an
 * in-memory implementation"). No Supabase, no SQL, no filesystem, no
 * network. Every future adapter (KR-02B-02+) is expected to be
 * behaviorally interchangeable with this one against the same test
 * suite (../__tests__/snapshot.repository.inMemory.test.js) — that
 * interchangeability is the point of the contract layer this class
 * implements.
 *
 * Stores certified domain Snapshot entities directly (not repository
 * DTOs) — the mapping layer (../mapping/snapshot.repository.mapper.js)
 * converts at the boundary on the way in (write) and out (read), so the
 * store's internal representation is always a validated, deep-frozen
 * domain entity, never an unvalidated DTO.
 */

const { SnapshotRepository } = require('../interfaces/snapshot.repository.interfaces');
const domain = require('../../domain');
const {
  dtoToSnapshotEntity,
  snapshotEntityToReadDTO,
  snapshotEntitiesToReadDTOs,
} = require('../mapping/snapshot.repository.mapper');
const {
  validateSnapshotCreateDTO,
  validateSnapshotUpdateDTO,
  validateSnapshotDeleteDTO,
  validateRepositoryIdentifierArgument,
  validateRepositorySubjectArgument,
  validateRepositoryScopeArgument,
} = require('../validation/snapshot.repository.validation');
const {
  SnapshotDuplicateError,
  SnapshotNotFoundError,
  SnapshotOperationNotSupportedError,
} = require('../errors/snapshot.repository.errors');

/**
 * Deep structural equality for two already-validated plain objects.
 * Used only to detect a true replay (write() called again with an
 * identical DTO) versus a genuine conflict (write() called with a
 * different DTO for an id that already exists). Safe to use JSON
 * comparison here because both sides are JSON-safe domain entity clones
 * (see ../mapping/snapshot.repository.mapper.js's
 * `snapshotEntityToReadDTO`), so no non-JSON-serializable value is ever
 * compared.
 */
function isDeepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function subjectMatches(a, b) {
  return a.subjectType === b.subjectType && a.subjectId === b.subjectId;
}

class InMemorySnapshotRepository extends SnapshotRepository {
  constructor() {
    super();
    /** @type {Map<string, import('../../domain/types/snapshot.types').Snapshot>} */
    this._store = new Map();
  }

  /** @param {import('../../domain/types/snapshot.types').SnapshotIdentifier} id */
  async findById(id) {
    validateRepositoryIdentifierArgument(id);
    const snapshot = this._store.get(id);
    return snapshot ? snapshotEntityToReadDTO(snapshot) : null;
  }

  /**
   * @param {import('../../domain/types/snapshot.types').SubjectReference} subject
   * @param {string} [scope]
   */
  async findLatest(subject, scope) {
    validateRepositorySubjectArgument(subject);
    validateRepositoryScopeArgument(scope);

    let latest = null;
    for (const snapshot of this._store.values()) {
      if (!subjectMatches(snapshot.subject, subject)) continue;
      if (scope !== undefined && snapshot.scope !== scope) continue;
      if (snapshot.supersessionState === domain.SnapshotSupersessionState.SUPERSEDED) continue;
      if (!latest || snapshot.version.version > latest.version.version) {
        latest = snapshot;
      }
    }
    return latest ? snapshotEntityToReadDTO(latest) : null;
  }

  /**
   * @param {import('../../domain/types/snapshot.types').SubjectReference} subject
   * @param {string} [scope]
   */
  async listBySubject(subject, scope) {
    validateRepositorySubjectArgument(subject);
    validateRepositoryScopeArgument(scope);

    const matches = [];
    for (const snapshot of this._store.values()) {
      if (!subjectMatches(snapshot.subject, subject)) continue;
      if (scope !== undefined && snapshot.scope !== scope) continue;
      matches.push(snapshot);
    }
    matches.sort((a, b) => a.version.version - b.version.version);
    return snapshotEntitiesToReadDTOs(matches);
  }

  /** @param {import('../dto/snapshot.repository.dto').SnapshotCreateDTO} dto */
  async write(dto) {
    validateSnapshotCreateDTO(dto);
    const entity = dtoToSnapshotEntity(dto);

    const existing = this._store.get(entity.id);
    if (existing) {
      if (isDeepEqual(existing, entity)) {
        // Idempotent replay of an identical write — per the certified
        // domain contract's requirement, this succeeds rather than
        // erroring.
        return snapshotEntityToReadDTO(existing);
      }
      throw new SnapshotDuplicateError(
        `A Snapshot with id "${entity.id}" already exists with different content`,
        { id: entity.id },
      );
    }

    this._store.set(entity.id, entity);
    return snapshotEntityToReadDTO(entity);
  }

  /** @param {import('../dto/snapshot.repository.dto').SnapshotUpdateDTO} dto */
  async update(dto) {
    validateSnapshotUpdateDTO(dto);
    const existing = this._store.get(dto.id);
    if (!existing) {
      throw new SnapshotNotFoundError(
        `Cannot update Snapshot "${dto.id}": no such record exists`,
        { id: dto.id },
      );
    }

    // Lifecycle/supersession-state transition only — every other field is
    // carried forward unchanged from the existing record, preserving
    // KR-01B's immutable-content guarantee. Re-validated and re-frozen
    // via domain.createSnapshot rather than mutated in place.
    const transitioned = domain.createSnapshot({
      id: existing.id,
      subject: existing.subject,
      scope: existing.scope,
      moment: existing.moment,
      context: existing.context,
      version: existing.version,
      state: existing.state,
      source: existing.source,
      ...(existing.confidence !== undefined ? { confidence: existing.confidence } : {}),
      trigger: existing.trigger,
      ...(existing.status !== undefined ? { status: existing.status } : {}),
      lifecycle: dto.lifecycle,
      supersessionState: dto.supersessionState,
      metadata: existing.metadata,
    });

    this._store.set(transitioned.id, transitioned);
    return snapshotEntityToReadDTO(transitioned);
  }

  /** @param {import('../dto/snapshot.repository.dto').SnapshotDeleteDTO} dto */
  async remove(dto) {
    validateSnapshotDeleteDTO(dto);
    throw new SnapshotOperationNotSupportedError(
      'Snapshot records are historical and append-only; deletion is never permitted',
      { id: dto.id },
    );
  }

  /**
   * Test/certification-only utility: clears the entire in-memory store.
   * Deliberately NOT part of SnapshotRepository / SnapshotWriteRepository
   * — no contract method name collision, and no adapter is expected to
   * implement this. Exists solely so the certified test suite (and any
   * future adapter's own test suite, per KR-02B-01's "future adapter
   * validation" purpose statement) can reset state between test cases
   * without going through the domain-facing (and intentionally
   * delete-less) write contract.
   */
  __reset() {
    this._store.clear();
  }
}

module.exports = {
  InMemorySnapshotRepository,
};
