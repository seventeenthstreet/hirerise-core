'use strict';

/**
 * @file core/src/modules/snapshot-intelligence/computation/index.js
 *
 * KR-02C — Snapshot Computation Engine
 *
 * Barrel export for the Snapshot Computation layer, following the same
 * convention the certified domain layer (domain/index.js) and the
 * certified repository layer (repository/index.js) already established:
 * later work packages building on top of computation (scoring, insight
 * generation, explainability, opportunity matching, CHI — see this work
 * package's Success Criteria) are expected to import through this file
 * rather than reaching into individual submodules directly.
 */

const errors = require('./errors/snapshot.computation.errors');
const { createSnapshotComputationContext } = require('./context/snapshot.computation.context');
const results = require('./results/snapshot.computation.results');
const validation = require('./validation/snapshot.computation.validation');
const { SnapshotComputationRule } = require('./rules/snapshot.computation.ruleContract');
const ruleEngine = require('./rules/snapshot.computation.ruleEngine');
const aggregation = require('./aggregation/snapshot.computation.aggregation');
const pipeline = require('./pipeline/snapshot.computation.pipeline');
const { SnapshotComputationEngine } = require('./engine/SnapshotComputationEngine');

module.exports = {
  // engine
  SnapshotComputationEngine,
  // context
  createSnapshotComputationContext,
  // results
  ...results,
  // rules
  SnapshotComputationRule,
  ...ruleEngine,
  // aggregation
  aggregation,
  // pipeline
  pipeline,
  // validation
  validation,
  // errors
  ...errors,
};
