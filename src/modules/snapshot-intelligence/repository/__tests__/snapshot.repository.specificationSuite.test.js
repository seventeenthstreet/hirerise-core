'use strict';

/**
 * @file repository/__tests__/snapshot.repository.specificationSuite.test.js
 *
 * KR-02B-03A — Snapshot Repository Behavioral Specification Suite.
 * Deliverable: Adapter Integration.
 *
 * Certifies InMemorySnapshotRepository against the reusable behavioral
 * specification suite. This file is intentionally thin — it contains no
 * assertions of its own, only wiring — because the specification itself
 * (repository/specifications/) is what defines correct behavior. A
 * future adapter (SupabaseSnapshotRepository, PostgreSQLSnapshotRepository,
 * ...) is certified the same way: swap the factory passed here, add
 * nothing else.
 *
 * This file is additive: it does not modify, replace, or duplicate the
 * certified KR-02B-01 test file
 * (./snapshot.repository.inMemory.test.js), which remains the
 * implementation-specific reference suite for InMemorySnapshotRepository
 * and must stay green.
 */

const { InMemorySnapshotRepository } = require('../inMemory/InMemorySnapshotRepository');
const { runFullSnapshotRepositorySpecification } = require('../specifications');

describe('InMemorySnapshotRepository — Behavioral Specification Certification', () => {
  runFullSnapshotRepositorySpecification(() => new InMemorySnapshotRepository());
});
