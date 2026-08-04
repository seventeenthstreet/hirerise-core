'use strict';

/**
 * @file core/src/modules/snapshot-intelligence/repository/specifications/fixtures/snapshot.repository.fixtures.js
 *
 * KR-02B-03A — Snapshot Repository Behavioral Specification Suite
 *
 * Reusable, implementation-independent fixtures for the specification
 * suite. Every fixture here builds a plain SnapshotCreateDTO-shaped
 * object — never a repository instance, never anything that assumes
 * in-memory storage, SQL, or any other persistence technology. A
 * specification imports these fixtures and hands them to whatever
 * repository a runner is currently certifying.
 *
 * Fixtures are built through the certified domain entity factories
 * (../../../domain/entities/snapshot.entities.js), then JSON round-tripped
 * into a plain object — the same approach the certified KR-02B-01 test
 * suite already uses (see ../../__tests__/snapshot.repository.inMemory.test.js).
 * This guarantees every fixture is a structurally and semantically valid
 * Snapshot per the certified domain layer, not a hand-rolled shape that
 * happens to look right.
 */

const { buildValidSnapshot } = require('../../../testHelpers/snapshot.fixtures');

/** Default subject used by every fixture unless a caller overrides it. */
const DEFAULT_SUBJECT = Object.freeze({ subjectType: 'STUDENT', subjectId: 'student-123' });

/** A second, distinct subject — useful for isolation / cross-subject specs. */
const OTHER_SUBJECT = Object.freeze({ subjectType: 'STUDENT', subjectId: 'a-different-student' });

/**
 * Deep-clones a domain Snapshot entity into a plain, JSON-safe object
 * shaped like a SnapshotCreateDTO. This is the only place the suite
 * reaches into the domain layer's entity factories — every other
 * fixture builds on top of this one function.
 *
 * @param {object} [overrides] - shallow overrides applied to the cloned DTO.
 * @returns {object} a SnapshotCreateDTO-shaped plain object.
 */
function buildValidCreateDTO(overrides = {}) {
  return { ...JSON.parse(JSON.stringify(buildValidSnapshot())), ...overrides };
}

/**
 * "Single Snapshot" fixture — one baseline, valid, first-version record.
 * The starting point for the majority of specification cases.
 */
function singleSnapshotFixture(overrides = {}) {
  return buildValidCreateDTO({ id: 'spec-snapshot-1', version: { version: 1 }, ...overrides });
}

/**
 * "Multi Version Snapshot" fixture — a chain of versions for the same
 * subject, with the final one marked as superseding the one before it.
 * `count` controls chain length; every version but the last is marked
 * SUPERSEDED so the chain has an unambiguous "latest".
 *
 * @param {number} [count]
 * @param {object} [subject]
 * @returns {object[]} an array of SnapshotCreateDTOs, oldest first.
 */
function multiVersionSnapshotFixture(count = 3, subject = DEFAULT_SUBJECT) {
  const dtos = [];
  for (let version = 1; version <= count; version += 1) {
    const isLatest = version === count;
    dtos.push(
      buildValidCreateDTO({
        id: `spec-snapshot-v${version}`,
        subject,
        version: version === 1 ? { version } : { version, supersedes: `spec-snapshot-v${version - 1}` },
        lifecycle: isLatest ? 'ACTIVE' : 'SUPERSEDED',
        supersessionState: isLatest ? 'CURRENT' : 'SUPERSEDED',
      }),
    );
  }
  return dtos;
}

/**
 * "Conflict Fixture" — two DTOs sharing an id but differing in content.
 * Writing the second after the first must be treated as a genuine
 * conflict (SnapshotDuplicateError), never a silent overwrite.
 */
function conflictFixture() {
  const base = singleSnapshotFixture({ id: 'spec-snapshot-conflict' });
  const conflicting = { ...base, scope: 'a-different-scope' };
  return { base, conflicting };
}

/**
 * "Duplicate Fixture" — a DTO and a structurally identical clone of
 * itself. Writing the clone after the original must be treated as an
 * idempotent replay, not a conflict and not a second record.
 */
function duplicateFixture() {
  const original = singleSnapshotFixture({ id: 'spec-snapshot-duplicate' });
  const replay = JSON.parse(JSON.stringify(original));
  return { original, replay };
}

/**
 * "Metadata Fixture" — a DTO with distinguishing metadata, useful for
 * specs that check metadata round-trips unchanged through write/read.
 */
function metadataFixture(overrides = {}) {
  return singleSnapshotFixture({
    id: 'spec-snapshot-metadata',
    metadata: {
      createdAt: '2026-01-01T00:00:00.000Z',
      preservedAt: '2026-01-01T00:00:01.000Z',
      origin: 'EVENT_TRIGGERED',
      visibility: 'SUBJECT',
      retentionPolicy: 'STANDARD',
      consistencyState: 'VERIFIED',
      ...overrides,
    },
  });
}

module.exports = {
  DEFAULT_SUBJECT,
  OTHER_SUBJECT,
  buildValidCreateDTO,
  singleSnapshotFixture,
  multiVersionSnapshotFixture,
  conflictFixture,
  duplicateFixture,
  metadataFixture,
};
