'use strict';

/**
 * @file core/src/modules/snapshot-intelligence/repository/dto/snapshot.repository.dto.js
 *
 * KR-02B-01 — Snapshot Repository Foundation
 *
 * Repository DTOs, per KR-02B-01's "Repository DTOs" deliverable.
 *
 * A repository DTO is distinct from the certified canonical DTO in
 * domain/dto/snapshot.dto.js: the canonical DTO (`SnapshotDTO`) is a
 * lossy, display-shaped projection meant for an API/event boundary (it
 * collapses `context.evidence` down to a count, for example). A
 * repository DTO must instead be a full-fidelity, round-trippable
 * representation of a Snapshot entity — a repository adapter needs every
 * field the domain layer's `createSnapshot` factory requires in order to
 * reconstruct the entity on read. So these DTOs are plain-object mirrors
 * of the domain Snapshot shape (see domain/types/snapshot.types.js's
 * `Snapshot` typedef), not the canonical DTO's flattened shape.
 *
 * Every DTO here is a plain object with no methods and no behavior —
 * persistence-neutral, per KR-02B-01's requirement. None of these types
 * know about Supabase, SQL, or any other storage technology; a future
 * adapter maps between its own storage row shape and these DTOs, never
 * the other way around.
 *
 * KR-01B's Historical Truth / append-only principle shapes two of these
 * DTOs in a way that is worth calling out explicitly:
 *
 *   - There is no "SnapshotUpdateDTO" that lets a caller change a
 *     Snapshot's preserved content. A changed subject state is always a
 *     *new* Snapshot with an incremented version (write() again with a
 *     new SnapshotCreateDTO) — never a mutation. The only thing
 *     SnapshotUpdateDTO represents is a lifecycle/supersession-state
 *     transition, which is metadata *about* a record's standing, not a
 *     change to what it preserved.
 *
 *   - SnapshotDeleteDTO exists because the milestone's deliverable list
 *     calls for it, but the write repository's `remove` operation always
 *     rejects it (see ../interfaces/snapshot.repository.interfaces.js
 *     and ../errors/snapshot.repository.errors.js's
 *     SnapshotOperationNotSupportedError) — historical Snapshot records
 *     are never deleted. The DTO and the rejection are both part of the
 *     contract: the interface makes the constraint visible and enforced,
 *     rather than merely undocumented.
 */

const { SnapshotRepositoryValidationError } = require('../errors/snapshot.repository.errors');

/**
 * @typedef {Object} SnapshotCreateDTO - Full-fidelity input to a write
 * repository's `write` operation. Field-for-field mirror of the domain
 * `Snapshot` shape (domain/types/snapshot.types.js) plus nothing else —
 * a repository DTO carries no repository-assigned fields (no
 * auto-generated id, no created-by-the-adapter timestamp); those are the
 * domain layer's responsibility via domain/entities/snapshot.entities.js.
 * @property {string} id
 * @property {Object} subject
 * @property {string} scope
 * @property {Object} moment
 * @property {Object} context
 * @property {Object} version
 * @property {Object} state
 * @property {Object} source
 * @property {Object} [confidence]
 * @property {Object} trigger
 * @property {string} [status]
 * @property {string} lifecycle
 * @property {string} supersessionState
 * @property {Object} metadata
 */

/**
 * @typedef {Object} SnapshotReadDTO - Full-fidelity output of a read
 * repository operation. Identical shape to SnapshotCreateDTO — reading a
 * Snapshot back out must never lose information a write put in — kept as
 * a separately named type because a future adapter may attach
 * read-path-only fields (e.g. `_source: 'cache'`) without that DTO also
 * being valid to pass back into a write operation. KR-02B-01 does not
 * add any such field itself.
 * @property {string} id
 * @property {Object} subject
 * @property {string} scope
 * @property {Object} moment
 * @property {Object} context
 * @property {Object} version
 * @property {Object} state
 * @property {Object} source
 * @property {Object} [confidence]
 * @property {Object} trigger
 * @property {string} [status]
 * @property {string} lifecycle
 * @property {string} supersessionState
 * @property {Object} metadata
 */

/**
 * @typedef {Object} SnapshotUpdateDTO - The only "update" a Snapshot
 * repository ever performs: a lifecycle/supersession-state transition.
 * Never carries `moment`, `context`, `state`, or any other preserved
 * content field — see file header.
 * @property {string} id - identifier of the existing Snapshot to
 * transition.
 * @property {string} lifecycle - new SnapshotLifecycle value.
 * @property {string} supersessionState - new SnapshotSupersessionState
 * value.
 */

/**
 * @typedef {Object} SnapshotDeleteDTO - Always rejected by
 * SnapshotWriteRepository#remove; see file header. Shape is intentionally
 * minimal since no adapter is expected to act on it.
 * @property {string} id - identifier of the Snapshot a caller is
 * (unsuccessfully) attempting to delete.
 * @property {string} [reason] - optional caller-supplied reason,
 * preserved only for the rejection error's metadata / audit trail.
 */

/**
 * @typedef {Object} SnapshotLookupDTO - Argument shape for read
 * operations that key on something other than a bare identifier.
 * Exactly one of `id` or `subject` must be present:
 *   - `{ id }` — single-record lookup (findById).
 *   - `{ subject, scope? }` — subject-scoped lookup (findLatest,
 *     listBySubject); `scope` narrows to one SnapshotScope, omitted means
 *     "every scope for this subject".
 * @property {string} [id]
 * @property {Object} [subject]
 * @property {string} [scope]
 */

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates a SnapshotCreateDTO's structural shape (presence of every
 * required field, correct primitive types where the field is a
 * primitive). Does NOT re-run domain validation — the mapping layer
 * (../mapping/snapshot.repository.mapper.js) is what hands the mapped
 * shape to the domain entity factories, which apply the certified domain
 * validation rules. This function only guards the repository boundary
 * against structurally malformed input reaching that mapping step.
 *
 * @param {SnapshotCreateDTO} dto
 * @throws {SnapshotRepositoryValidationError}
 */
function validateSnapshotCreateDTO(dto) {
  if (!isPlainObject(dto)) {
    throw new SnapshotRepositoryValidationError('SnapshotCreateDTO must be a plain object', { dto });
  }
  const requiredFields = [
    'id', 'subject', 'scope', 'moment', 'context', 'version', 'state',
    'source', 'trigger', 'lifecycle', 'supersessionState', 'metadata',
  ];
  requiredFields.forEach((field) => {
    if (dto[field] === undefined) {
      throw new SnapshotRepositoryValidationError(
        `SnapshotCreateDTO is missing required field "${field}"`,
        { dto, field },
      );
    }
  });
  if (typeof dto.id !== 'string' || dto.id.length === 0) {
    throw new SnapshotRepositoryValidationError('SnapshotCreateDTO.id must be a non-empty string', { dto });
  }
}

/**
 * Validates a SnapshotUpdateDTO's structural shape.
 *
 * @param {SnapshotUpdateDTO} dto
 * @throws {SnapshotRepositoryValidationError}
 */
function validateSnapshotUpdateDTO(dto) {
  if (!isPlainObject(dto)) {
    throw new SnapshotRepositoryValidationError('SnapshotUpdateDTO must be a plain object', { dto });
  }
  if (typeof dto.id !== 'string' || dto.id.length === 0) {
    throw new SnapshotRepositoryValidationError('SnapshotUpdateDTO.id must be a non-empty string', { dto });
  }
  if (typeof dto.lifecycle !== 'string' || dto.lifecycle.length === 0) {
    throw new SnapshotRepositoryValidationError('SnapshotUpdateDTO.lifecycle must be a non-empty string', { dto });
  }
  if (typeof dto.supersessionState !== 'string' || dto.supersessionState.length === 0) {
    throw new SnapshotRepositoryValidationError('SnapshotUpdateDTO.supersessionState must be a non-empty string', { dto });
  }
}

/**
 * Validates a SnapshotDeleteDTO's structural shape. Structural validity
 * does not imply the operation is permitted — see file header and
 * SnapshotOperationNotSupportedError.
 *
 * @param {SnapshotDeleteDTO} dto
 * @throws {SnapshotRepositoryValidationError}
 */
function validateSnapshotDeleteDTO(dto) {
  if (!isPlainObject(dto)) {
    throw new SnapshotRepositoryValidationError('SnapshotDeleteDTO must be a plain object', { dto });
  }
  if (typeof dto.id !== 'string' || dto.id.length === 0) {
    throw new SnapshotRepositoryValidationError('SnapshotDeleteDTO.id must be a non-empty string', { dto });
  }
  if (dto.reason !== undefined && typeof dto.reason !== 'string') {
    throw new SnapshotRepositoryValidationError('SnapshotDeleteDTO.reason must be a string when present', { dto });
  }
}

/**
 * Validates a SnapshotLookupDTO's structural shape: exactly one of `id`
 * or `subject` must be present.
 *
 * @param {SnapshotLookupDTO} dto
 * @throws {SnapshotRepositoryValidationError}
 */
function validateSnapshotLookupDTO(dto) {
  if (!isPlainObject(dto)) {
    throw new SnapshotRepositoryValidationError('SnapshotLookupDTO must be a plain object', { dto });
  }
  const hasId = dto.id !== undefined;
  const hasSubject = dto.subject !== undefined;
  if (hasId === hasSubject) {
    throw new SnapshotRepositoryValidationError(
      'SnapshotLookupDTO must specify exactly one of "id" or "subject"',
      { dto },
    );
  }
  if (hasId && (typeof dto.id !== 'string' || dto.id.length === 0)) {
    throw new SnapshotRepositoryValidationError('SnapshotLookupDTO.id must be a non-empty string', { dto });
  }
  if (hasSubject && !isPlainObject(dto.subject)) {
    throw new SnapshotRepositoryValidationError('SnapshotLookupDTO.subject must be a plain object', { dto });
  }
  if (dto.scope !== undefined && typeof dto.scope !== 'string') {
    throw new SnapshotRepositoryValidationError('SnapshotLookupDTO.scope must be a string when present', { dto });
  }
}

module.exports = {
  validateSnapshotCreateDTO,
  validateSnapshotUpdateDTO,
  validateSnapshotDeleteDTO,
  validateSnapshotLookupDTO,
};
