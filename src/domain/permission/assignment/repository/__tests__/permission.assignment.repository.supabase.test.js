'use strict';

/**
 * @file src/domain/permission/assignment/repository/__tests__/permission.assignment.repository.supabase.test.js
 *
 * BLOCKER 3C — Permission Assignment Persistence
 *
 * Behavioral-parity spec for SupabaseAssignmentRepository, mirroring
 * ../../__tests__/permission.assignment.repository.inMemory.test.js
 * test-for-test — same operations, same expectations — so the two
 * repositories are provably interchangeable behind AssignmentRepository.
 *
 * Uses a small, self-contained fake scoped to this file only (not the
 * shared cross-domain modules/knowledge-runtime/.../supabaseMock.js),
 * because that shared fake's `.insert()` always unconditionally succeeds
 * — it has no notion of a UNIQUE constraint. Duplicate-prevention here is
 * a database guarantee (permission_assignments_identity_key), so the
 * fake needs to actually enforce uniqueness on `assignment_identity` and
 * return a Postgres-shaped unique-violation error (`code: '23505'`) the
 * same way a real Postgres table would, which is what
 * SupabaseAssignmentRepository.create() is written to detect.
 */

const { RESOURCES, ACTIONS } = require('../../../permission.constants');
const { createAssignment } = require('../../permission.assignment.model');
const { DuplicateAssignmentError, AssignmentNotFoundError } = require('../../permission.assignment.errors');

function makeAssignment(overrides = {}) {
  return createAssignment({
    principalId: overrides.principalId ?? 'u-1',
    resource: overrides.resource ?? RESOURCES.JOB_LISTING,
    action: overrides.action ?? ACTIONS.VIEW,
  });
}

/**
 * Minimal fake enforcing exactly what this repository needs: unique
 * `assignment_identity` on insert (mapped to a Postgres-shaped 23505
 * error, matching real Postgres/Supabase behavior), `.eq()` filtering,
 * `.maybeSingle()`/`.single()`, `.delete()...select()`, and
 * `{ count: 'exact', head: true }`.
 */
function createFakeTable() {
  let rows = [];

  function query() {
    const state = { filters: [], isDelete: false, isCount: false };
    const api = {
      insert(payload) {
        if (rows.some((r) => r.assignment_identity === payload.assignment_identity)) {
          state.forcedError = {
            code: '23505',
            message: `duplicate key value violates unique constraint "permission_assignments_identity_key"`,
          };
          state.insertedRow = null;
        } else {
          state.insertedRow = { id: `row-${rows.length + 1}`, created_at: new Date().toISOString(), ...payload };
          rows.push(state.insertedRow);
        }
        return api;
      },
      delete() {
        state.isDelete = true;
        return api;
      },
      select(_cols, opts) {
        if (opts && opts.count) state.isCount = true;
        return api;
      },
      eq(field, value) {
        state.filters.push([field, value]);
        return api;
      },
      maybeSingle() {
        state.single = true;
        return api;
      },
      single() {
        state.single = true;
        return api;
      },
      then(resolve, reject) {
        return Promise.resolve(resolveQuery()).then(resolve, reject);
      },
    };
    function resolveQuery() {
      if (state.forcedError) return { data: null, error: state.forcedError };

      if (state.insertedRow) return { data: state.insertedRow, error: null };

      let matched = rows.filter((r) => state.filters.every(([f, v]) => r[f] === v));

      if (state.isDelete) {
        const removedIds = new Set(matched.map((r) => r.id));
        rows = rows.filter((r) => !removedIds.has(r.id));
        return { data: matched, error: null };
      }

      if (state.isCount) return { data: null, error: null, count: matched.length };

      if (state.single) return { data: matched[0] ?? null, error: null };

      return { data: matched, error: null };
    }
    return api;
  }

  return { from: () => query() };
}

let mockFakeSupabase;

jest.mock('../../../../../config/supabase', () => ({
  get supabase() {
    return mockFakeSupabase;
  },
}));

const { SupabaseAssignmentRepository } = require('../permission.assignment.repository.supabase');

describe('SupabaseAssignmentRepository', () => {
  beforeEach(() => {
    mockFakeSupabase = createFakeTable();
  });

  test('create() stores an Assignment retrievable via find()', async () => {
    const repo = new SupabaseAssignmentRepository();
    const assignment = makeAssignment();
    await repo.create(assignment);
    const found = await repo.find(assignment.assignmentIdentity);
    expect(found).toEqual(assignment);
  });

  test('create() throws DuplicateAssignmentError when the database reports a unique-constraint violation', async () => {
    const repo = new SupabaseAssignmentRepository();
    const assignment = makeAssignment();
    await repo.create(assignment);
    await expect(repo.create(assignment)).rejects.toThrow(DuplicateAssignmentError);
  });

  test('find() returns null for a missing identity', async () => {
    const repo = new SupabaseAssignmentRepository();
    expect(await repo.find('nope::nope:nope')).toBeNull();
  });

  test('get() throws AssignmentNotFoundError for a missing identity', async () => {
    const repo = new SupabaseAssignmentRepository();
    await expect(repo.get('nope::nope:nope')).rejects.toThrow(AssignmentNotFoundError);
  });

  test('get() returns the Assignment when it exists', async () => {
    const repo = new SupabaseAssignmentRepository();
    const assignment = makeAssignment();
    await repo.create(assignment);
    expect(await repo.get(assignment.assignmentIdentity)).toEqual(assignment);
  });

  test('delete() removes an existing Assignment and returns true', async () => {
    const repo = new SupabaseAssignmentRepository();
    const assignment = makeAssignment();
    await repo.create(assignment);
    expect(await repo.delete(assignment.assignmentIdentity)).toBe(true);
    expect(await repo.find(assignment.assignmentIdentity)).toBeNull();
  });

  test('delete() is safe (returns false) for a missing identity', async () => {
    const repo = new SupabaseAssignmentRepository();
    expect(await repo.delete('nope::nope:nope')).toBe(false);
  });

  test("findByPrincipal() returns only that principal's Assignments", async () => {
    const repo = new SupabaseAssignmentRepository();
    const a1 = makeAssignment({ principalId: 'u-1', resource: RESOURCES.JOB_LISTING, action: ACTIONS.VIEW });
    const a2 = makeAssignment({ principalId: 'u-1', resource: RESOURCES.SKILL, action: ACTIONS.UPDATE });
    const a3 = makeAssignment({ principalId: 'u-2', resource: RESOURCES.JOB_LISTING, action: ACTIONS.VIEW });
    await repo.create(a1);
    await repo.create(a2);
    await repo.create(a3);
    const results = await repo.findByPrincipal('u-1');
    expect(results).toHaveLength(2);
    expect(results.map((a) => a.assignmentIdentity).sort()).toEqual([a1.assignmentIdentity, a2.assignmentIdentity].sort());
  });

  test('findByPermission() returns only Assignments of that Permission, across principals', async () => {
    const repo = new SupabaseAssignmentRepository();
    const a1 = makeAssignment({ principalId: 'u-1', resource: RESOURCES.JOB_LISTING, action: ACTIONS.VIEW });
    const a2 = makeAssignment({ principalId: 'u-2', resource: RESOURCES.JOB_LISTING, action: ACTIONS.VIEW });
    const a3 = makeAssignment({ principalId: 'u-1', resource: RESOURCES.SKILL, action: ACTIONS.UPDATE });
    await repo.create(a1);
    await repo.create(a2);
    await repo.create(a3);
    const results = await repo.findByPermission(a1.permissionIdentity);
    expect(results).toHaveLength(2);
  });

  test('count() reflects the number of stored Assignments', async () => {
    const repo = new SupabaseAssignmentRepository();
    expect(await repo.count()).toBe(0);
    await repo.create(makeAssignment({ principalId: 'u-1' }));
    await repo.create(makeAssignment({ principalId: 'u-2' }));
    expect(await repo.count()).toBe(2);
  });

  test('two repository instances sharing the same backing store observe the same Assignment (multi-instance parity)', async () => {
    const instanceA = new SupabaseAssignmentRepository();
    const instanceB = new SupabaseAssignmentRepository();
    const assignment = makeAssignment({ principalId: 'u-shared' });
    await instanceA.create(assignment);
    expect(await instanceB.find(assignment.assignmentIdentity)).toEqual(assignment);
  });
});
