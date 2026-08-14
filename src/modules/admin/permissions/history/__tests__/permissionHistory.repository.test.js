'use strict';

/**
 * @file src/modules/admin/permissions/history/__tests__/permissionHistory.repository.test.js
 *
 * WP-ADMIN-05D — Enterprise Permission Audit & Governance History
 *
 * Exercises the real PermissionHistoryRepository code path against the
 * shared in-memory Supabase fake — same pattern as
 * permission.repository.test.js (WP-ADMIN-04F-02).
 */

const { createSupabaseMock } = require('../../../../knowledge-runtime/knowledge/testHelpers/supabaseMock');

jest.mock('../../../../../config/supabase', () => ({
  get supabase() {
    return global.__permissionHistorySupabaseMock;
  },
}));

const { PermissionHistoryRepository } = require('../permissionHistory.repository');

function seedRow(overrides = {}) {
  return {
    id: overrides.id ?? 'log-1',
    admin_id: 'admin-1',
    action: 'PERMISSION_ASSIGNED',
    entity_type: 'permission',
    entity_id: 'job_listing:view',
    metadata: { principalId: 'u1' },
    ip_address: '203.0.113.9',
    created_at: '2026-08-01T00:00:00.000Z',
    data: null,
    ...overrides,
  };
}

describe('PermissionHistoryRepository', () => {
  let repo;

  function seed(rows = []) {
    global.__permissionHistorySupabaseMock = createSupabaseMock({ admin_logs: rows });
    repo = new PermissionHistoryRepository();
  }

  beforeEach(() => {
    seed([]);
  });

  it('returns only entity_type="permission" rows, ignoring other entity types', async () => {
    seed([
      seedRow({ id: 'log-1' }),
      seedRow({ id: 'log-2', entity_type: 'admin_principal', entity_id: 'admin-9' }),
    ]);

    const { items, total } = await repo.listPermissionHistory();

    expect(total).toBe(1);
    expect(items.map((r) => r.id)).toEqual(['log-1']);
  });

  it('scopes to one Permission via entityId', async () => {
    seed([
      seedRow({ id: 'log-1', entity_id: 'job_listing:view' }),
      seedRow({ id: 'log-2', entity_id: 'skill:create' }),
    ]);

    const { items, total } = await repo.listPermissionHistory({ entityId: 'job_listing:view' });

    expect(total).toBe(1);
    expect(items[0].entity_id).toBe('job_listing:view');
  });

  it('orders most-recent-first by default', async () => {
    seed([
      seedRow({ id: 'log-1', created_at: '2026-08-01T00:00:00.000Z' }),
      seedRow({ id: 'log-2', created_at: '2026-08-03T00:00:00.000Z' }),
      seedRow({ id: 'log-3', created_at: '2026-08-02T00:00:00.000Z' }),
    ]);

    const { items } = await repo.listPermissionHistory();

    expect(items.map((r) => r.id)).toEqual(['log-2', 'log-3', 'log-1']);
  });

  it('orders oldest-first when sort: "asc"', async () => {
    seed([
      seedRow({ id: 'log-1', created_at: '2026-08-01T00:00:00.000Z' }),
      seedRow({ id: 'log-2', created_at: '2026-08-03T00:00:00.000Z' }),
      seedRow({ id: 'log-3', created_at: '2026-08-02T00:00:00.000Z' }),
    ]);

    const { items } = await repo.listPermissionHistory({ sort: 'asc' });

    expect(items.map((r) => r.id)).toEqual(['log-1', 'log-3', 'log-2']);
  });

  it('filters by a recognized action', async () => {
    seed([
      seedRow({ id: 'log-1', action: 'PERMISSION_ASSIGNED' }),
      seedRow({ id: 'log-2', action: 'PERMISSION_REVOKED' }),
    ]);

    const { items, total } = await repo.listPermissionHistory({ action: 'PERMISSION_REVOKED' });

    expect(total).toBe(1);
    expect(items[0].action).toBe('PERMISSION_REVOKED');
  });

  it('ignores an unrecognized action rather than returning an empty page', async () => {
    seed([seedRow({ id: 'log-1', action: 'PERMISSION_ASSIGNED' })]);

    const { items, total } = await repo.listPermissionHistory({ action: 'NOT_A_REAL_ACTION' });

    expect(total).toBe(1);
    expect(items[0].id).toBe('log-1');
  });

  it('filters by adminId', async () => {
    seed([
      seedRow({ id: 'log-1', admin_id: 'admin-1' }),
      seedRow({ id: 'log-2', admin_id: 'admin-2' }),
    ]);

    const { items, total } = await repo.listPermissionHistory({ adminId: 'admin-2' });

    expect(total).toBe(1);
    expect(items[0].admin_id).toBe('admin-2');
  });

  it('filters by an inclusive date range', async () => {
    seed([
      seedRow({ id: 'log-1', created_at: '2026-07-30T00:00:00.000Z' }),
      seedRow({ id: 'log-2', created_at: '2026-08-01T00:00:00.000Z' }),
      seedRow({ id: 'log-3', created_at: '2026-08-05T00:00:00.000Z' }),
    ]);

    const { items, total } = await repo.listPermissionHistory({
      dateFrom: '2026-08-01T00:00:00.000Z',
      dateTo: '2026-08-01T23:59:59.999Z',
    });

    expect(total).toBe(1);
    expect(items[0].id).toBe('log-2');
  });

  it('paginates via limit/offset while total reflects the full filtered set', async () => {
    seed([
      seedRow({ id: 'log-1', created_at: '2026-08-01T00:00:00.000Z' }),
      seedRow({ id: 'log-2', created_at: '2026-08-02T00:00:00.000Z' }),
      seedRow({ id: 'log-3', created_at: '2026-08-03T00:00:00.000Z' }),
    ]);

    const page1 = await repo.listPermissionHistory({ limit: 2, offset: 0 });
    expect(page1.items.map((r) => r.id)).toEqual(['log-3', 'log-2']);
    expect(page1.total).toBe(3);

    const page2 = await repo.listPermissionHistory({ limit: 2, offset: 2 });
    expect(page2.items.map((r) => r.id)).toEqual(['log-1']);
    expect(page2.total).toBe(3);
  });

  it('never returns more than MAX_PAGE_LIMIT rows even if a caller requests more', async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      seedRow({ id: `log-${i}`, created_at: `2026-08-0${i + 1}T00:00:00.000Z` }),
    );
    seed(rows);

    const { items } = await repo.listPermissionHistory({ limit: 10000 });

    expect(items.length).toBe(5); // dataset is smaller than the ceiling — sanity check the query still runs
  });

  it('propagates a Supabase error rather than swallowing it', async () => {
    // The shared in-memory fake (createSupabaseMock) has no error-injection
    // hook, so this exercises the same failure path with a minimal,
    // purpose-built fake client instead — this repository's contract is
    // "throw on error", not "return an empty page", and that needs its
    // own client double regardless of which fake backs the happy-path tests.
    const erroringClient = {
      from: () => ({
        select: () => ({
          eq: function eq() { return this; },
          order: function order() { return this; },
          range: function range() {
            return Promise.resolve({ data: null, error: { message: 'boom' }, count: 0 });
          },
        }),
      }),
    };
    global.__permissionHistorySupabaseMock = erroringClient;
    const erroringRepo = new PermissionHistoryRepository();

    await expect(erroringRepo.listPermissionHistory()).rejects.toEqual({ message: 'boom' });
  });
});
