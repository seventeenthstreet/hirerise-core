'use strict';

/**
 * @file repository/__tests__/snapshot.repository.inMemory.test.js
 * KR-02B-01 — Snapshot Repository Foundation — in-memory reference
 * implementation: CRUD, invariants, immutability, and error handling.
 */

const { InMemorySnapshotRepository } = require('../inMemory/InMemorySnapshotRepository');
const {
  SnapshotDuplicateError,
  SnapshotNotFoundError,
  SnapshotOperationNotSupportedError,
  SnapshotRepositoryValidationError,
} = require('../errors/snapshot.repository.errors');
const { buildValidSnapshot } = require('../../testHelpers/snapshot.fixtures');

function buildValidCreateDTO(overrides = {}) {
  return { ...JSON.parse(JSON.stringify(buildValidSnapshot())), ...overrides };
}

const SUBJECT = { subjectType: 'STUDENT', subjectId: 'student-123' };

describe('InMemorySnapshotRepository — write / findById', () => {
  let repo;
  beforeEach(() => {
    repo = new InMemorySnapshotRepository();
  });

  it('write() persists a Snapshot retrievable via findById()', async () => {
    const dto = buildValidCreateDTO();
    const written = await repo.write(dto);
    expect(written.id).toBe(dto.id);

    const found = await repo.findById(dto.id);
    expect(found).toEqual(written);
  });

  it('findById() returns null for a record that does not exist', async () => {
    expect(await repo.findById('does-not-exist')).toBeNull();
  });

  it('findById() rejects a non-string identifier', async () => {
    await expect(repo.findById(42)).rejects.toThrow(SnapshotRepositoryValidationError);
  });

  it('write() is idempotent under replay of an identical DTO', async () => {
    const dto = buildValidCreateDTO();
    const first = await repo.write(dto);
    const second = await repo.write(dto);
    expect(second).toEqual(first);
  });

  it('write() rejects a differing DTO reusing an existing id (conflict, not upsert)', async () => {
    const dto = buildValidCreateDTO();
    await repo.write(dto);
    const conflicting = buildValidCreateDTO({ scope: 'a-different-scope' });
    await expect(repo.write(conflicting)).rejects.toThrow(SnapshotDuplicateError);
  });

  it('write() rejects a structurally invalid DTO', async () => {
    const dto = buildValidCreateDTO();
    delete dto.metadata;
    await expect(repo.write(dto)).rejects.toThrow(SnapshotRepositoryValidationError);
  });

  it('the read record returned by findById() is not the frozen internal entity', async () => {
    const dto = buildValidCreateDTO();
    await repo.write(dto);
    const found = await repo.findById(dto.id);
    expect(Object.isFrozen(found)).toBe(false);
    // mutating the returned read DTO must never affect what the repository holds
    found.lifecycle = 'MUTATED';
    const foundAgain = await repo.findById(dto.id);
    expect(foundAgain.lifecycle).not.toBe('MUTATED');
  });
});

describe('InMemorySnapshotRepository — findLatest / listBySubject', () => {
  let repo;
  beforeEach(() => {
    repo = new InMemorySnapshotRepository();
  });

  it('findLatest() returns null when no snapshot exists for the subject', async () => {
    expect(await repo.findLatest(SUBJECT)).toBeNull();
  });

  it('findLatest() returns the highest-version, non-superseded snapshot', async () => {
    await repo.write(buildValidCreateDTO({ id: 's-1', version: { version: 1 } }));
    await repo.write(buildValidCreateDTO({ id: 's-2', version: { version: 2 } }));
    await repo.write(buildValidCreateDTO({
      id: 's-3', version: { version: 3, supersedes: 's-2' }, lifecycle: 'SUPERSEDED', supersessionState: 'SUPERSEDED',
    }));

    const latest = await repo.findLatest(SUBJECT);
    expect(latest.id).toBe('s-2');
  });

  it('findLatest() respects an optional scope filter', async () => {
    await repo.write(buildValidCreateDTO({ id: 's-resume', scope: 'resume', version: { version: 1 } }));
    await repo.write(buildValidCreateDTO({ id: 's-skills', scope: 'skills', version: { version: 2 } }));

    const latest = await repo.findLatest(SUBJECT, 'resume');
    expect(latest.id).toBe('s-resume');
  });

  it('listBySubject() returns every matching snapshot ordered by version ascending', async () => {
    await repo.write(buildValidCreateDTO({ id: 's-2', version: { version: 2, supersedes: 's-1' } }));
    await repo.write(buildValidCreateDTO({ id: 's-1', version: { version: 1 } }));

    const list = await repo.listBySubject(SUBJECT);
    expect(list.map((s) => s.id)).toEqual(['s-1', 's-2']);
  });

  it('listBySubject() excludes snapshots for a different subject', async () => {
    await repo.write(buildValidCreateDTO({ id: 's-1' }));
    const otherSubject = { subjectType: 'STUDENT', subjectId: 'a-different-student' };
    const otherDto = buildValidCreateDTO({ id: 's-other-subject', subject: otherSubject });
    otherDto.moment = { ...otherDto.moment, subject: otherSubject };
    await repo.write(otherDto);

    const list = await repo.listBySubject(SUBJECT);
    expect(list.map((s) => s.id)).toEqual(['s-1']);
  });

  it('findLatest() / listBySubject() reject a malformed subject argument', async () => {
    await expect(repo.findLatest({ subjectType: 'STUDENT' })).rejects.toThrow(SnapshotRepositoryValidationError);
    await expect(repo.listBySubject('not-an-object')).rejects.toThrow(SnapshotRepositoryValidationError);
  });
});

describe('InMemorySnapshotRepository — update (lifecycle transition only)', () => {
  let repo;
  beforeEach(() => {
    repo = new InMemorySnapshotRepository();
  });

  it('update() transitions lifecycle/supersessionState without touching preserved content', async () => {
    const dto = buildValidCreateDTO();
    await repo.write(dto);

    const updated = await repo.update({ id: dto.id, lifecycle: 'SUPERSEDED', supersessionState: 'SUPERSEDED' });
    expect(updated.lifecycle).toBe('SUPERSEDED');
    expect(updated.supersessionState).toBe('SUPERSEDED');
    // every other field is untouched
    expect(updated.moment).toEqual(dto.moment);
    expect(updated.context).toEqual(dto.context);
    expect(updated.state).toEqual(dto.state);
    expect(updated.version).toEqual(dto.version);
  });

  it('update() rejects a transition for a record that does not exist', async () => {
    await expect(repo.update({ id: 'nope', lifecycle: 'ACTIVE', supersessionState: 'CURRENT' }))
      .rejects.toThrow(SnapshotNotFoundError);
  });

  it('update() rejects a structurally invalid DTO', async () => {
    await expect(repo.update({ id: 'nope' })).rejects.toThrow(SnapshotRepositoryValidationError);
  });
});

describe('InMemorySnapshotRepository — remove (always unsupported)', () => {
  let repo;
  beforeEach(() => {
    repo = new InMemorySnapshotRepository();
  });

  it('remove() always rejects with SnapshotOperationNotSupportedError for a structurally valid DTO', async () => {
    const dto = buildValidCreateDTO();
    await repo.write(dto);
    await expect(repo.remove({ id: dto.id })).rejects.toThrow(SnapshotOperationNotSupportedError);

    // the record must still exist — remove() never mutates the store
    expect(await repo.findById(dto.id)).not.toBeNull();
  });

  it('remove() still structurally validates its DTO before rejecting', async () => {
    await expect(repo.remove({})).rejects.toThrow(SnapshotRepositoryValidationError);
  });
});

describe('InMemorySnapshotRepository — __reset() test utility', () => {
  it('clears the store without being part of the public repository contract', async () => {
    const repo = new InMemorySnapshotRepository();
    const dto = buildValidCreateDTO();
    await repo.write(dto);
    expect(await repo.findById(dto.id)).not.toBeNull();

    repo.__reset();
    expect(await repo.findById(dto.id)).toBeNull();
  });
});
