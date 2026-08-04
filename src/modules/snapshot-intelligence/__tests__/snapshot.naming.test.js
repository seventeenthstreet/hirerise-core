'use strict';

/**
 * @file core-work/src/modules/snapshot-intelligence/__tests__/snapshot.naming.test.js
 * KR-02A — Snapshot Domain Foundation — Naming consistency tests
 *
 * Verifies that no work package after KR-02A can drift the domain
 * vocabulary apart: every entity/value-object factory has a same-named
 * validator, and every same-named validator has a registry entry (see
 * KR-02A's Success Criteria: "No later work package shall redefine,
 * duplicate, or replace any Snapshot Intelligence domain entity").
 */

const entities = require('../domain/entities/snapshot.entities');
const valueObjects = require('../domain/value-objects/snapshot.valueObjects');
const validation = require('../domain/schemas/snapshot.validation');
const { SCHEMA_REGISTRY } = require('../domain/schemas/snapshot.schema');

function factoryNameToTypeName(factoryName) {
  // createSnapshot -> Snapshot, createContextEnvelope -> ContextEnvelope
  return factoryName.replace(/^create/, '');
}

describe('entity factory / validator / registry naming consistency', () => {
  const entityFactoryNames = Object.keys(entities).filter((k) => k.startsWith('create'));

  entityFactoryNames.forEach((factoryName) => {
    const typeName = factoryNameToTypeName(factoryName);
    const validatorName = `validate${typeName}`;

    it(`${factoryName} has a matching validator (${validatorName})`, () => {
      expect(typeof validation[validatorName]).toBe('function');
    });

    it(`${factoryName} has a matching SCHEMA_REGISTRY entry (${typeName})`, () => {
      expect(SCHEMA_REGISTRY[typeName]).toBeDefined();
    });
  });
});

describe('value object factory / validator / registry naming consistency', () => {
  const voFactoryNames = Object.keys(valueObjects).filter((k) => k.startsWith('create'));

  voFactoryNames.forEach((factoryName) => {
    const typeName = factoryNameToTypeName(factoryName);
    const validatorName = `validate${typeName}`;

    it(`${factoryName} has a matching validator (${validatorName})`, () => {
      expect(typeof validation[validatorName]).toBe('function');
    });

    it(`${factoryName} has a matching SCHEMA_REGISTRY entry (${typeName})`, () => {
      expect(SCHEMA_REGISTRY[typeName]).toBeDefined();
    });
  });
});

describe('no orphaned registry entries', () => {
  it('every SCHEMA_REGISTRY entry corresponds to a real factory', () => {
    const allFactoryTypeNames = new Set([
      ...Object.keys(entities).filter((k) => k.startsWith('create')).map(factoryNameToTypeName),
      ...Object.keys(valueObjects).filter((k) => k.startsWith('create')).map(factoryNameToTypeName),
    ]);
    Object.keys(SCHEMA_REGISTRY).forEach((registeredName) => {
      expect(allFactoryTypeNames.has(registeredName)).toBe(true);
    });
  });
});
