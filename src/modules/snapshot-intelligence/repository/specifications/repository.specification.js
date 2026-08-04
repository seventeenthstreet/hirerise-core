'use strict';

/**
 * @file core/src/modules/snapshot-intelligence/repository/specifications/repository.specification.js
 *
 * KR-02B-03A — Snapshot Repository Behavioral Specification Suite
 * Deliverable: Repository Behavior Specification.
 *
 * Certifies every capability exposed by the certified KR-02B-01
 * SnapshotRepository contract: write(), update(), remove(), findById(),
 * findLatest(), listBySubject(). Nothing here assumes a storage
 * technology — every case is expressed purely in terms of the public
 * contract's inputs and outputs, so the exact same specification runs
 * unchanged against InMemorySnapshotRepository today and any future
 * adapter (Supabase, PostgreSQL, ...) later.
 *
 * Usage (see ../__tests__/snapshot.repository.specificationSuite.test.js
 * for the reference wiring):
 *
 *   const { runRepositorySpecification } = require('.../specifications');
 *   describe('MyAdapter', () => {
 *     runRepositorySpecification(() => new MyAdapterRepository(...));
 *   });
 *
 * `createRepository` is called fresh in every `beforeEach` — the
 * specification never assumes a repository exposes any reset/teardown
 * utility beyond what the certified contract itself defines, since such
 * a utility (e.g. InMemorySnapshotRepository's `__reset()`) is explicitly
 * documented as test-only and not part of the contract.
 */

/* global describe, it, beforeEach */

const {
  SnapshotDuplicateError,
  SnapshotNotFoundError,
  SnapshotOperationNotSupportedError,
  SnapshotRepositoryValidationError,
} = require('../errors/snapshot.repository.errors');

const {
  buildValidCreateDTO,
  singleSnapshotFixture,
  conflictFixture,
  duplicateFixture,
  metadataFixture,
  DEFAULT_SUBJECT,
  OTHER_SUBJECT,
} = require('./fixtures/snapshot.repository.fixtures');

const {
  assertRepositoryContractShape,
  assertRepositoryInvariant,
  assertDeterministicRead,
  assertIdempotentWrite,
  assertRejectsWith,
  assertNoSideEffectFromRejection,
  assertNoMutationLeak,
} = require('./assertions/snapshot.repository.assertions');

/**
 * Runs the full Repository Behavior Specification against whatever
 * repository `createRepository()` produces.
 *
 * @param {() => object} createRepository - factory returning a fresh,
 * empty repository instance. Never a pre-built instance — the
 * specification must never know which implementation it is certifying.
 */
function runRepositorySpecification(createRepository) {
  describe('Repository Behavior Specification (KR-02B-03A)', () => {
    let repo;

    beforeEach(() => {
      repo = createRepository();
    });

    describe('repository creation', () => {
      it('produces an object satisfying the certified SnapshotRepository contract shape', () => {
        assertRepositoryContractShape(repo);
      });
    });

    describe('write() / findById() — CRUD and read/write consistency', () => {
      it('persists a record retrievable by the same identifier', async () => {
        const dto = singleSnapshotFixture();
        const written = await repo.write(dto);
        const found = await repo.findById(dto.id);
        assertRepositoryInvariant(written, dto);
        assertRepositoryInvariant(found, dto);
      });

      it('lookup consistency: findById() returns null for an identifier that was never written', async () => {
        const missing = await repo.findById('specification-suite-nonexistent-id');
        expect(missing).toBeNull();
      });

      it('identifier behavior: findById() rejects a non-string identifier', async () => {
        await assertRejectsWith(repo.findById(42), SnapshotRepositoryValidationError);
      });

      it('null handling: a lookup for a record that does not exist resolves to null rather than throwing', async () => {
        await expect(repo.findById('still-does-not-exist')).resolves.toBeNull();
      });

      it('deterministic reads: two reads of the same record with no write between them are identical', async () => {
        const dto = singleSnapshotFixture();
        await repo.write(dto);
        const first = await repo.findById(dto.id);
        const second = await repo.findById(dto.id);
        assertDeterministicRead(first, second);
      });

      it('read isolation: mutating a returned read result never affects what the repository holds', async () => {
        const dto = singleSnapshotFixture();
        await repo.write(dto);
        const found = await repo.findById(dto.id);
        found.lifecycle = 'MUTATED-BY-SPECIFICATION-SUITE';
        const foundAgain = await repo.findById(dto.id);
        assertNoMutationLeak(found, foundAgain, 'lifecycle');
      });

      it('write consistency: metadata round-trips through write() and findById() unchanged', async () => {
        const dto = metadataFixture();
        await repo.write(dto);
        const found = await repo.findById(dto.id);
        expect(found.metadata).toEqual(dto.metadata);
      });
    });

    describe('write() — idempotency and duplicate handling', () => {
      it('idempotent write behavior: replaying an identical DTO succeeds and returns the same record', async () => {
        const { original, replay } = duplicateFixture();
        const first = await repo.write(original);
        const second = await repo.write(replay);
        assertIdempotentWrite(first, second);
      });

      it('duplicate handling: writing a different DTO under an existing id is a conflict, not an overwrite', async () => {
        const { base, conflicting } = conflictFixture();
        await repo.write(base);
        await assertRejectsWith(repo.write(conflicting), SnapshotDuplicateError);

        // append-only enforcement: the rejected conflicting write must not
        // have altered the existing record.
        const stillOriginal = await repo.findById(base.id);
        assertNoSideEffectFromRejection(stillOriginal, await repo.findById(base.id));
        expect(stillOriginal.scope).toBe(base.scope);
      });

      it('write() rejects a structurally invalid DTO', async () => {
        const dto = singleSnapshotFixture();
        delete dto.metadata;
        await assertRejectsWith(repo.write(dto), SnapshotRepositoryValidationError);
      });
    });

    describe('findLatest() / listBySubject() — lookup consistency', () => {
      it('findLatest() returns null when no record exists for the subject', async () => {
        expect(await repo.findLatest(DEFAULT_SUBJECT)).toBeNull();
      });

      it('listBySubject() returns an empty list when no record exists for the subject', async () => {
        expect(await repo.listBySubject(DEFAULT_SUBJECT)).toEqual([]);
      });

      it('listBySubject() excludes records belonging to a different subject', async () => {
        const mine = buildValidCreateDTO({ id: 'spec-mine', subject: DEFAULT_SUBJECT });
        const theirs = buildValidCreateDTO({ id: 'spec-theirs', subject: OTHER_SUBJECT });
        theirs.moment = { ...theirs.moment, subject: OTHER_SUBJECT };
        await repo.write(mine);
        await repo.write(theirs);

        const list = await repo.listBySubject(DEFAULT_SUBJECT);
        expect(list.map((record) => record.id)).toEqual(['spec-mine']);
      });

      it('findLatest() / listBySubject() reject a malformed subject argument', async () => {
        await assertRejectsWith(repo.findLatest({ subjectType: 'STUDENT' }), SnapshotRepositoryValidationError);
        await assertRejectsWith(repo.listBySubject('not-an-object'), SnapshotRepositoryValidationError);
      });
    });

    describe('update() — lifecycle/supersession-state transition only', () => {
      it('transitions lifecycle/supersessionState without altering any other field', async () => {
        const dto = singleSnapshotFixture();
        await repo.write(dto);

        const updated = await repo.update({ id: dto.id, lifecycle: 'SUPERSEDED', supersessionState: 'SUPERSEDED' });
        expect(updated.lifecycle).toBe('SUPERSEDED');
        expect(updated.supersessionState).toBe('SUPERSEDED');
        expect(updated.moment).toEqual(dto.moment);
        expect(updated.context).toEqual(dto.context);
        expect(updated.state).toEqual(dto.state);
        expect(updated.version).toEqual(dto.version);
      });

      it('update lifecycle restrictions: rejects a transition for a record that does not exist', async () => {
        await assertRejectsWith(
          repo.update({ id: 'specification-suite-nonexistent-id', lifecycle: 'ACTIVE', supersessionState: 'CURRENT' }),
          SnapshotNotFoundError,
        );
      });

      it('update() rejects a structurally invalid DTO', async () => {
        await assertRejectsWith(repo.update({ id: 'irrelevant' }), SnapshotRepositoryValidationError);
      });
    });

    describe('remove() — append-only enforcement', () => {
      it('remove rejection behavior: always rejects with SnapshotOperationNotSupportedError', async () => {
        const dto = singleSnapshotFixture();
        await repo.write(dto);
        await assertRejectsWith(repo.remove({ id: dto.id }), SnapshotOperationNotSupportedError);
      });

      it('append-only enforcement: a rejected remove() never removes the record', async () => {
        const dto = singleSnapshotFixture();
        await repo.write(dto);
        await repo.remove({ id: dto.id }).catch(() => {});
        const stillThere = await repo.findById(dto.id);
        expect(stillThere).not.toBeNull();
      });

      it('remove() structurally validates its DTO before rejecting for unsupported-ness', async () => {
        await assertRejectsWith(repo.remove({}), SnapshotRepositoryValidationError);
      });
    });

    describe('repository invariants and isolation', () => {
      it('repository isolation: two independently-created repository instances never share state', async () => {
        const repoA = createRepository();
        const repoB = createRepository();
        const dto = singleSnapshotFixture();
        await repoA.write(dto);
        expect(await repoB.findById(dto.id)).toBeNull();
      });

      it('deterministic writes: writing two distinct records is order-independent for later reads', async () => {
        const first = buildValidCreateDTO({ id: 'spec-order-1', version: { version: 1 } });
        const second = buildValidCreateDTO({ id: 'spec-order-2', version: { version: 2 } });
        await repo.write(second);
        await repo.write(first);

        const list = await repo.listBySubject(DEFAULT_SUBJECT);
        expect(list.map((record) => record.id).sort()).toEqual(['spec-order-1', 'spec-order-2']);
      });
    });
  });
}

module.exports = { runRepositorySpecification };
