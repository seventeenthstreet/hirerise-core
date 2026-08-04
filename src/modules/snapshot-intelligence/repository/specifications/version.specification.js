'use strict';

/**
 * @file core/src/modules/snapshot-intelligence/repository/specifications/version.specification.js
 *
 * KR-02B-03A — Snapshot Repository Behavioral Specification Suite
 * Deliverable: Version Behavior Specification.
 *
 * Certifies version-related behavior using ONLY the certified public
 * repository contract (findById, findLatest, listBySubject, write,
 * update) and the existing `version` field already present on every
 * Snapshot DTO. This specification introduces no new repository
 * methods, no cursor, no pagination, and no traversal API — every case
 * is expressed as a sequence of certified-contract calls.
 *
 * Per the KR-02B-03A revision: version chain / supersession behavior is
 * certified only to the extent it is *observable* through the existing
 * contract (findLatest() excluding SUPERSEDED records, listBySubject()
 * returning every version in ascending order). Anything beyond that
 * (e.g. a dedicated "get version chain" traversal) is out of scope — see
 * ../specifications/CAPABILITY_ASSESSMENT.md.
 */

/* global describe, it, beforeEach */

const { SnapshotRepositoryValidationError } = require('../errors/snapshot.repository.errors');
const { buildValidCreateDTO, multiVersionSnapshotFixture, DEFAULT_SUBJECT } = require('./fixtures/snapshot.repository.fixtures');
const { assertVersionOrdering, assertLatestVersion, assertRejectsWith } = require('./assertions/snapshot.repository.assertions');

/**
 * Runs the full Version Behavior Specification against whatever
 * repository `createRepository()` produces.
 *
 * @param {() => object} createRepository - factory returning a fresh,
 * empty repository instance.
 */
function runVersionSpecification(createRepository) {
  describe('Version Behavior Specification (KR-02B-03A)', () => {
    let repo;

    beforeEach(() => {
      repo = createRepository();
    });

    describe('version existence', () => {
      it('every record returned by the repository carries its version field unchanged', async () => {
        const dto = buildValidCreateDTO({ id: 'spec-version-existence', version: { version: 7 } });
        const written = await repo.write(dto);
        const found = await repo.findById(dto.id);
        expect(written.version).toEqual({ version: 7 });
        expect(found.version).toEqual({ version: 7 });
      });
    });

    describe('latest version retrieval', () => {
      it('findLatest() returns the highest-version, non-superseded record for a subject', async () => {
        const chain = multiVersionSnapshotFixture(3);
        for (const dto of chain) {
          // eslint-disable-next-line no-await-in-loop
          await repo.write(dto);
        }
        const latest = await repo.findLatest(DEFAULT_SUBJECT);
        assertLatestVersion(latest, 'spec-snapshot-v3');
      });

      it('findLatest() respects an optional scope filter', async () => {
        await repo.write(buildValidCreateDTO({ id: 'spec-scope-resume', scope: 'resume', version: { version: 1 } }));
        await repo.write(buildValidCreateDTO({ id: 'spec-scope-skills', scope: 'skills', version: { version: 2 } }));

        const latest = await repo.findLatest(DEFAULT_SUBJECT, 'resume');
        expect(latest.id).toBe('spec-scope-resume');
      });

      it('deterministic version retrieval: repeated findLatest() calls with no intervening write agree', async () => {
        const chain = multiVersionSnapshotFixture(2);
        for (const dto of chain) {
          // eslint-disable-next-line no-await-in-loop
          await repo.write(dto);
        }
        const first = await repo.findLatest(DEFAULT_SUBJECT);
        const second = await repo.findLatest(DEFAULT_SUBJECT);
        expect(second).toEqual(first);
      });
    });

    describe('version ordering', () => {
      it('listBySubject() returns every version for a subject in ascending version order', async () => {
        const chain = multiVersionSnapshotFixture(4);
        // write in reverse to prove the repository orders on read, not on write.
        for (const dto of [...chain].reverse()) {
          // eslint-disable-next-line no-await-in-loop
          await repo.write(dto);
        }
        const list = await repo.listBySubject(DEFAULT_SUBJECT);
        assertVersionOrdering(list);
        expect(list.map((record) => record.id)).toEqual(chain.map((dto) => dto.id));
      });

      it('listBySubject() ordering is stable across repeated calls', async () => {
        const chain = multiVersionSnapshotFixture(3);
        for (const dto of chain) {
          // eslint-disable-next-line no-await-in-loop
          await repo.write(dto);
        }
        const first = await repo.listBySubject(DEFAULT_SUBJECT);
        const second = await repo.listBySubject(DEFAULT_SUBJECT);
        expect(second).toEqual(first);
      });
    });

    describe('version consistency', () => {
      it('a written version value is never altered by an unrelated write to a different record', async () => {
        const dto = buildValidCreateDTO({ id: 'spec-version-stable', version: { version: 5 } });
        await repo.write(dto);
        await repo.write(buildValidCreateDTO({ id: 'spec-version-unrelated', version: { version: 1 } }));

        const found = await repo.findById(dto.id);
        expect(found.version).toEqual({ version: 5 });
      });

      it('a lifecycle/supersession-state transition via update() never changes the version field', async () => {
        const dto = buildValidCreateDTO({ id: 'spec-version-update', version: { version: 2 } });
        await repo.write(dto);
        const updated = await repo.update({ id: dto.id, lifecycle: 'SUPERSEDED', supersessionState: 'SUPERSEDED' });
        expect(updated.version).toEqual({ version: 2 });
      });
    });

    describe('supersession consistency (observable through the certified contract only)', () => {
      it('a SUPERSEDED record is excluded from findLatest() but still present in listBySubject()', async () => {
        const chain = multiVersionSnapshotFixture(2); // v1 SUPERSEDED, v2 CURRENT
        for (const dto of chain) {
          // eslint-disable-next-line no-await-in-loop
          await repo.write(dto);
        }

        const latest = await repo.findLatest(DEFAULT_SUBJECT);
        expect(latest.id).toBe('spec-snapshot-v2');

        const all = await repo.listBySubject(DEFAULT_SUBJECT);
        expect(all.map((record) => record.id)).toContain('spec-snapshot-v1');
      });

      it('findLatest() / listBySubject() reject a malformed subject argument (shared identifier behavior)', async () => {
        await assertRejectsWith(repo.findLatest('not-an-object'), SnapshotRepositoryValidationError);
      });
    });
  });
}

module.exports = { runVersionSpecification };
