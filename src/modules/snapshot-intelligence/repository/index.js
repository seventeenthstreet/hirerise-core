'use strict';

/**
 * @file core/src/modules/snapshot-intelligence/repository/index.js
 *
 * KR-02B-01 — Snapshot Repository Foundation
 *
 * Barrel export for the Snapshot Repository layer, following the same
 * convention the certified domain layer established
 * (domain/index.js): later work packages (KR-02B-02 onward) import
 * repository contracts, DTOs, and the in-memory reference implementation
 * through this file rather than reaching into individual submodules.
 */

const errors = require('./errors/snapshot.repository.errors');
const dto = require('./dto/snapshot.repository.dto');
const mapping = require('./mapping/snapshot.repository.mapper');
const validation = require('./validation/snapshot.repository.validation');
const contracts = require('./contracts/snapshot.repository.contracts');
const interfaces = require('./interfaces/snapshot.repository.interfaces');
const { InMemorySnapshotRepository } = require('./inMemory/InMemorySnapshotRepository');

module.exports = {
  // errors
  ...errors,
  // dto validators
  dto,
  // mapping
  mapping,
  // validation (repository-boundary; re-exports dto validators + contract compliance too)
  validation,
  // contracts
  contracts,
  // interfaces (abstract base classes)
  ...interfaces,
  // reference implementation
  InMemorySnapshotRepository,
};
