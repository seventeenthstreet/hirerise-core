'use strict';

/**
 * @file core-work/src/modules/snapshot-intelligence/__tests__/snapshot.schema.test.js
 * KR-02A — Snapshot Domain Foundation — Schema registry tests
 */

const { SCHEMA_REGISTRY } = require('../domain/schemas/snapshot.schema');

const EXPECTED_ENTITIES = [
  'SnapshotIdentifier', 'MomentIdentifier', 'SubjectReference', 'SnapshotVersion',
  'SnapshotState', 'SnapshotMetadata', 'SnapshotEvidenceReference', 'EvolutionReference',
  'NarrativeReference', 'ExplanationReference', 'GovernanceEvidenceReference', 'Moment',
  'ContextEnvelope', 'Snapshot',
];

const EXPECTED_VALUE_OBJECTS = [
  'MomentType', 'MomentCategory', 'SnapshotTimestamp', 'SnapshotReason', 'SnapshotSource',
  'SnapshotConfidence', 'SnapshotTrigger', 'SnapshotScope', 'SnapshotStatus', 'ContextScope',
  'EvidenceReference', 'SignalReference', 'DomainReference', 'RelationshipReference',
  'VersionReference',
];

describe('SCHEMA_REGISTRY', () => {
  it('registers every domain entity named in KR-02A', () => {
    EXPECTED_ENTITIES.forEach((name) => {
      expect(SCHEMA_REGISTRY[name]).toBeDefined();
      expect(SCHEMA_REGISTRY[name].kind).toBe('entity');
    });
  });

  it('registers every value object named in KR-02A', () => {
    EXPECTED_VALUE_OBJECTS.forEach((name) => {
      expect(SCHEMA_REGISTRY[name]).toBeDefined();
      expect(SCHEMA_REGISTRY[name].kind).toBe('value-object');
    });
  });

  it('has exactly 14 entities and 15 value objects, matching KR-02A scope', () => {
    const entities = Object.values(SCHEMA_REGISTRY).filter((e) => e.kind === 'entity');
    const valueObjects = Object.values(SCHEMA_REGISTRY).filter((e) => e.kind === 'value-object');
    expect(entities).toHaveLength(14);
    expect(valueObjects).toHaveLength(15);
  });

  it('gives every registry entry a validate function and a domainReference', () => {
    Object.entries(SCHEMA_REGISTRY).forEach(([name, entry]) => {
      expect(typeof entry.validate).toBe('function');
      expect(typeof entry.domainReference).toBe('string');
      expect(entry.domainReference.length).toBeGreaterThan(0);
    });
  });

  it('is frozen at the top level, preventing accidental registry mutation', () => {
    expect(Object.isFrozen(SCHEMA_REGISTRY)).toBe(true);
  });
});
