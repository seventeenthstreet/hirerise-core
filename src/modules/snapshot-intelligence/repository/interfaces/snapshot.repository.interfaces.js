'use strict';

/**
 * @file core/src/modules/snapshot-intelligence/repository/interfaces/snapshot.repository.interfaces.js
 *
 * KR-02B-01 — Snapshot Repository Foundation
 *
 * Repository interfaces, per KR-02B-01's "Repository Interfaces"
 * deliverable: SnapshotRepository, SnapshotReadRepository,
 * SnapshotWriteRepository.
 *
 * These are abstract base classes, not the domain layer's plain-object /
 * factory-function convention — deliberately so, because a repository
 * (unlike a domain entity) is a *behavior* boundary (methods that
 * perform I/O against some store), not a *value* boundary (immutable
 * data). Every method throws unless overridden by a concrete
 * implementation (../inMemory/InMemorySnapshotRepository.js today, a real
 * adapter in a later milestone). This mirrors how an interface would be
 * enforced in a statically-typed language, adapted to this codebase's
 * plain-JS convention.
 *
 * Extending these classes is optional, not required, for an
 * implementation to be considered contract-compliant — what actually
 * matters is the runtime method-presence check in
 * ../contracts/snapshot.repository.contracts.js's
 * `assertRepositoryContractCompliance`, per this codebase's existing
 * duck-typing convention (e.g. shared/repositories/base.repository.js is
 * not required by anything that consumes a repository). Extending these
 * classes is the recommended path because it gets a caller a clear
 * "not implemented" error for any method a subclass forgets, rather than
 * a silent `undefined is not a function`.
 */

const { SnapshotRepositoryError } = require('../errors/snapshot.repository.errors');

function notImplemented(className, methodName) {
  throw new SnapshotRepositoryError(
    `${className}.${methodName}() is not implemented`,
    'SNAPSHOT_REPOSITORY_METHOD_NOT_IMPLEMENTED',
    { className, methodName },
  );
}

/**
 * @implements {import('../contracts/snapshot.repository.contracts').SnapshotReadRepository}
 */
class SnapshotReadRepository {
  /** @param {import('../../domain/types/snapshot.types').SnapshotIdentifier} id */
  // eslint-disable-next-line no-unused-vars
  async findById(id) {
    notImplemented(this.constructor.name, 'findById');
  }

  /**
   * @param {import('../../domain/types/snapshot.types').SubjectReference} subject
   * @param {string} [scope]
   */
  // eslint-disable-next-line no-unused-vars
  async findLatest(subject, scope) {
    notImplemented(this.constructor.name, 'findLatest');
  }

  /**
   * @param {import('../../domain/types/snapshot.types').SubjectReference} subject
   * @param {string} [scope]
   */
  // eslint-disable-next-line no-unused-vars
  async listBySubject(subject, scope) {
    notImplemented(this.constructor.name, 'listBySubject');
  }
}

/**
 * @implements {import('../contracts/snapshot.repository.contracts').SnapshotWriteRepository}
 */
class SnapshotWriteRepository {
  /** @param {import('../dto/snapshot.repository.dto').SnapshotCreateDTO} dto */
  // eslint-disable-next-line no-unused-vars
  async write(dto) {
    notImplemented(this.constructor.name, 'write');
  }

  /** @param {import('../dto/snapshot.repository.dto').SnapshotUpdateDTO} dto */
  // eslint-disable-next-line no-unused-vars
  async update(dto) {
    notImplemented(this.constructor.name, 'update');
  }

  /** @param {import('../dto/snapshot.repository.dto').SnapshotDeleteDTO} dto */
  // eslint-disable-next-line no-unused-vars
  async remove(dto) {
    notImplemented(this.constructor.name, 'remove');
  }
}

/**
 * Canonical repository abstraction combining read and write, per
 * KR-02B-01's "SnapshotRepository — Canonical repository abstraction"
 * deliverable. Implemented via composition-through-inheritance (extends
 * both base classes' methods by re-declaring the same "not implemented"
 * behavior) rather than multiple inheritance, since JS classes cannot
 * extend two bases — a concrete implementation extends this single class
 * and gets every read + write method to override.
 *
 * @implements {import('../contracts/snapshot.repository.contracts').SnapshotRepository}
 */
class SnapshotRepository {
  // eslint-disable-next-line no-unused-vars
  async findById(id) {
    notImplemented(this.constructor.name, 'findById');
  }

  // eslint-disable-next-line no-unused-vars
  async findLatest(subject, scope) {
    notImplemented(this.constructor.name, 'findLatest');
  }

  // eslint-disable-next-line no-unused-vars
  async listBySubject(subject, scope) {
    notImplemented(this.constructor.name, 'listBySubject');
  }

  // eslint-disable-next-line no-unused-vars
  async write(dto) {
    notImplemented(this.constructor.name, 'write');
  }

  // eslint-disable-next-line no-unused-vars
  async update(dto) {
    notImplemented(this.constructor.name, 'update');
  }

  // eslint-disable-next-line no-unused-vars
  async remove(dto) {
    notImplemented(this.constructor.name, 'remove');
  }
}

module.exports = {
  SnapshotReadRepository,
  SnapshotWriteRepository,
  SnapshotRepository,
};
