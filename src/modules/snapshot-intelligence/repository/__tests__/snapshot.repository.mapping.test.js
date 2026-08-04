'use strict';

/**
 * @file repository/__tests__/snapshot.repository.mapping.test.js
 * KR-02B-01 — Snapshot Repository Foundation — DTO <-> Entity mapping tests
 */

const {
  dtoToSnapshotEntity,
  snapshotEntityToReadDTO,
  snapshotEntitiesToReadDTOs,
} = require('../mapping/snapshot.repository.mapper');
const { SnapshotRepositoryValidationError } = require('../errors/snapshot.repository.errors');
const { SnapshotDomainError } = require('../../domain/errors/snapshot.errors');
const { buildValidSnapshot } = require('../../testHelpers/snapshot.fixtures');

function buildValidCreateDTO(overrides = {}) {
  return { ...JSON.parse(JSON.stringify(buildValidSnapshot())), ...overrides };
}

describe('dtoToSnapshotEntity', () => {
  it('maps a valid SnapshotCreateDTO to a certified domain entity', () => {
    const dto = buildValidCreateDTO();
    const entity = dtoToSnapshotEntity(dto);

    expect(entity.id).toBe(dto.id);
    expect(entity.subject).toEqual(dto.subject);
    expect(entity.scope).toBe(dto.scope);
    expect(entity.version.version).toBe(dto.version.version);
    expect(entity.lifecycle).toBe(dto.lifecycle);
  });

  it('returns a deep-frozen entity (domain immutability guarantee carries through)', () => {
    const entity = dtoToSnapshotEntity(buildValidCreateDTO());
    expect(Object.isFrozen(entity)).toBe(true);
    expect(Object.isFrozen(entity.moment)).toBe(true);
    expect(() => {
      entity.lifecycle = 'SUPERSEDED';
    }).toThrow(TypeError);
  });

  it('rejects a structurally invalid DTO before reaching the domain layer', () => {
    const dto = buildValidCreateDTO();
    delete dto.moment;
    expect(() => dtoToSnapshotEntity(dto)).toThrow(SnapshotRepositoryValidationError);
  });

  it('surfaces certified domain validation errors for structurally-present but semantically invalid fields', () => {
    const dto = buildValidCreateDTO({ lifecycle: 'NOT_A_REAL_LIFECYCLE_VALUE' });
    expect(() => dtoToSnapshotEntity(dto)).toThrow(SnapshotDomainError);
  });
});

describe('snapshotEntityToReadDTO', () => {
  it('produces a full-fidelity, JSON-safe, unfrozen clone of the entity', () => {
    const entity = buildValidSnapshot();
    const readDTO = snapshotEntityToReadDTO(entity);

    expect(readDTO).toEqual(JSON.parse(JSON.stringify(entity)));
    expect(Object.isFrozen(readDTO)).toBe(false);
    expect(readDTO).not.toBe(entity);
  });

  it('round-trips through dtoToSnapshotEntity without loss', () => {
    const entity = buildValidSnapshot();
    const readDTO = snapshotEntityToReadDTO(entity);
    const roundTripped = dtoToSnapshotEntity(readDTO);
    expect(roundTripped).toEqual(entity);
  });
});

describe('snapshotEntitiesToReadDTOs', () => {
  it('maps a list of entities preserving order', () => {
    const a = buildValidSnapshot();
    const b = buildValidSnapshot({ id: 'snapshot-456' });
    const readDTOs = snapshotEntitiesToReadDTOs([a, b]);
    expect(readDTOs.map((d) => d.id)).toEqual(['snapshot-123', 'snapshot-456']);
  });
});
