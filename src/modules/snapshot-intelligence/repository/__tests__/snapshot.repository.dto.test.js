'use strict';

/**
 * @file repository/__tests__/snapshot.repository.dto.test.js
 * KR-02B-01 — Snapshot Repository Foundation — DTO structural validation tests
 */

const {
  validateSnapshotCreateDTO,
  validateSnapshotUpdateDTO,
  validateSnapshotDeleteDTO,
  validateSnapshotLookupDTO,
} = require('../dto/snapshot.repository.dto');
const { SnapshotRepositoryValidationError } = require('../errors/snapshot.repository.errors');
const { buildValidSnapshot } = require('../../testHelpers/snapshot.fixtures');

function buildValidCreateDTO(overrides = {}) {
  return { ...JSON.parse(JSON.stringify(buildValidSnapshot())), ...overrides };
}

describe('validateSnapshotCreateDTO', () => {
  it('accepts a fully-populated, valid DTO', () => {
    expect(() => validateSnapshotCreateDTO(buildValidCreateDTO())).not.toThrow();
  });

  it('rejects a non-object', () => {
    expect(() => validateSnapshotCreateDTO(null)).toThrow(SnapshotRepositoryValidationError);
    expect(() => validateSnapshotCreateDTO('snapshot-123')).toThrow(SnapshotRepositoryValidationError);
  });

  it.each([
    'id', 'subject', 'scope', 'moment', 'context', 'version', 'state',
    'source', 'trigger', 'lifecycle', 'supersessionState', 'metadata',
  ])('rejects a DTO missing required field "%s"', (field) => {
    const dto = buildValidCreateDTO();
    delete dto[field];
    expect(() => validateSnapshotCreateDTO(dto)).toThrow(SnapshotRepositoryValidationError);
  });

  it('rejects a non-string id', () => {
    expect(() => validateSnapshotCreateDTO(buildValidCreateDTO({ id: 123 }))).toThrow(
      SnapshotRepositoryValidationError,
    );
  });
});

describe('validateSnapshotUpdateDTO', () => {
  it('accepts a valid lifecycle transition DTO', () => {
    expect(() => validateSnapshotUpdateDTO({
      id: 'snapshot-123',
      lifecycle: 'SUPERSEDED',
      supersessionState: 'SUPERSEDED',
    })).not.toThrow();
  });

  it('rejects a missing id', () => {
    expect(() => validateSnapshotUpdateDTO({ lifecycle: 'ACTIVE', supersessionState: 'CURRENT' }))
      .toThrow(SnapshotRepositoryValidationError);
  });

  it('rejects a missing lifecycle', () => {
    expect(() => validateSnapshotUpdateDTO({ id: 'x', supersessionState: 'CURRENT' }))
      .toThrow(SnapshotRepositoryValidationError);
  });

  it('rejects a missing supersessionState', () => {
    expect(() => validateSnapshotUpdateDTO({ id: 'x', lifecycle: 'ACTIVE' }))
      .toThrow(SnapshotRepositoryValidationError);
  });
});

describe('validateSnapshotDeleteDTO', () => {
  it('accepts a minimal valid DTO', () => {
    expect(() => validateSnapshotDeleteDTO({ id: 'snapshot-123' })).not.toThrow();
  });

  it('accepts an optional string reason', () => {
    expect(() => validateSnapshotDeleteDTO({ id: 'snapshot-123', reason: 'test cleanup' })).not.toThrow();
  });

  it('rejects a non-string reason', () => {
    expect(() => validateSnapshotDeleteDTO({ id: 'snapshot-123', reason: 42 }))
      .toThrow(SnapshotRepositoryValidationError);
  });

  it('rejects a missing id', () => {
    expect(() => validateSnapshotDeleteDTO({})).toThrow(SnapshotRepositoryValidationError);
  });
});

describe('validateSnapshotLookupDTO', () => {
  it('accepts an id-only lookup', () => {
    expect(() => validateSnapshotLookupDTO({ id: 'snapshot-123' })).not.toThrow();
  });

  it('accepts a subject-only lookup with optional scope', () => {
    expect(() => validateSnapshotLookupDTO({
      subject: { subjectType: 'STUDENT', subjectId: 'student-1' },
      scope: 'resume',
    })).not.toThrow();
  });

  it('rejects a lookup with neither id nor subject', () => {
    expect(() => validateSnapshotLookupDTO({})).toThrow(SnapshotRepositoryValidationError);
  });

  it('rejects a lookup with both id and subject', () => {
    expect(() => validateSnapshotLookupDTO({
      id: 'snapshot-123',
      subject: { subjectType: 'STUDENT', subjectId: 'student-1' },
    })).toThrow(SnapshotRepositoryValidationError);
  });
});
