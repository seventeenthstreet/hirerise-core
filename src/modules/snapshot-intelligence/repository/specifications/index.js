'use strict';

/**
 * @file core/src/modules/snapshot-intelligence/repository/specifications/index.js
 *
 * KR-02B-03A — Snapshot Repository Behavioral Specification Suite.
 *
 * Single entry point for every runner, fixture, and assertion the suite
 * exposes. A future adapter's test file needs only:
 *
 *   const { runFullSnapshotRepositorySpecification } = require('.../specifications');
 *   describe('SupabaseSnapshotRepository', () => {
 *     runFullSnapshotRepositorySpecification(() => new SupabaseSnapshotRepository(...));
 *   });
 *
 * See README.md for the full certification workflow and
 * CAPABILITY_ASSESSMENT.md for which capabilities this suite does (and
 * deliberately does not) certify.
 */

/* global describe */

const { runRepositorySpecification } = require('./repository.specification');
const { runVersionSpecification } = require('./version.specification');

const fixtures = require('./fixtures/snapshot.repository.fixtures');
const assertions = require('./assertions/snapshot.repository.assertions');

/**
 * Convenience runner: runs every specification the suite currently
 * certifies (Repository Behavior + Version Behavior) against a single
 * repository factory, grouped under one top-level `describe`.
 *
 * @param {() => object} createRepository
 */
function runFullSnapshotRepositorySpecification(createRepository) {
  describe('Snapshot Repository Behavioral Specification Suite (KR-02B-03A)', () => {
    runRepositorySpecification(createRepository);
    runVersionSpecification(createRepository);
  });
}

module.exports = {
  runRepositorySpecification,
  runVersionSpecification,
  runFullSnapshotRepositorySpecification,
  fixtures,
  assertions,
};
