'use strict';

/**
 * @file core/src/modules/snapshot-intelligence/computation/testHelpers/computation.fixtures.js
 *
 * KR-02C — Snapshot Computation Engine — shared test fixtures.
 *
 * Builds Snapshot entities via the certified testHelpers fixture
 * (../../testHelpers/snapshot.fixtures.js), not hand-built plain
 * objects, so computation tests are implicitly exercising real,
 * certified domain entity construction — the same convention the
 * repository layer's own tests already follow.
 */

const { buildValidSnapshot } = require('../../testHelpers/snapshot.fixtures');
const { createSnapshotComputationContext } = require('../context/snapshot.computation.context');

function buildComputationSnapshots(count = 2, scope = 'resume') {
  return Array.from({ length: count }, (_, i) => buildValidSnapshot({
    id: `snapshot-${i + 1}`,
    scope,
  }));
}

function buildComputationContext(overrides = {}) {
  return createSnapshotComputationContext({
    scope: 'resume',
    options: {},
    parameters: {},
    executedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  });
}

module.exports = {
  buildComputationSnapshots,
  buildComputationContext,
};
