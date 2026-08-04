'use strict';

/**
 * @file core-work/src/modules/snapshot-intelligence/domain/index.js
 *
 * KR-02A — Snapshot Domain Foundation
 *
 * Barrel export for the Snapshot Intelligence domain layer, per KR-02A's
 * "Barrel Exports" deliverable. Every later work package (KR-02B through
 * KR-02J) is expected to import domain contracts through this file
 * rather than reaching into individual submodules directly, so the
 * public surface of the domain layer is this file's export list, not
 * every file under domain/.
 */

const entities = require('./entities/snapshot.entities');
const valueObjects = require('./value-objects/snapshot.valueObjects');
const constants = require('./constants/snapshot.constants');
const errors = require('./errors/snapshot.errors');
const validation = require('./schemas/snapshot.validation');
const { SCHEMA_REGISTRY } = require('./schemas/snapshot.schema');
const dto = require('./dto/snapshot.dto');
const eventContracts = require('./events/snapshot.eventContracts');
const { CONTRACT_VERSIONS } = require('./contracts/snapshot.contracts');

module.exports = {
  // entities
  ...entities,
  // value objects
  ...valueObjects,
  // constants / enumerations
  ...constants,
  // errors
  ...errors,
  // validation
  validation,
  SCHEMA_REGISTRY,
  // contracts
  ...dto,
  ...eventContracts,
  CONTRACT_VERSIONS,
};
