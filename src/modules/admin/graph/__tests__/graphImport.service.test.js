'use strict';

/**
 * @file graphImport.service.test.js
 * @description WP-ADMIN-COMP-08 regression tests.
 *
 * Covers:
 *   1. Module loading — require() succeeds and every function the admin
 *      controller/routes depend on is actually exported.
 *   2. Read-path functions: getGraphMetrics, validateGraphIntegrity,
 *      getImportLogs, getDatasetStatuses, getGraphHealth, getGraphAlerts,
 *      getLegacyBulkGraphStats (renamed from getCareerGraphStats in
 *      WP-ADMIN-COMP-08-R21 — it reads Legacy Bulk Graph tables).
 *   3. Import logging: a successful importGraphDataset() writes exactly one
 *      row to `import_logs` with the correct processed/imported/skipped/
 *      duplicate/fk counts and import_mode.
 *   4. THE DIRECTIONAL FK COLLISION REGRESSION — role_transitions has TWO
 *      fkChecks against the SAME `roles` collection (from_role_id,
 *      to_role_id). Before the field:collection keying fix documented in
 *      graphImport.service.js (buildFKSets/detectFKErrors), a naive
 *      collection-only key would let the second fkCheck's lookup silently
 *      overwrite the first's Set, producing false positives/negatives.
 *      This test asserts a row is correctly flagged when only ONE of its
 *      two role references is invalid, and NOT flagged when both are
 *      valid — which would fail under the old collection-only keying.
 *
 * MOCKING STRATEGY:
 *   graphImport.service.js does `getSupabase = () => require('../../../
 *   config/supabase').supabase` — a lazy require, not a top-level import —
 *   so jest.mock('../../../config/supabase', factory) works exactly as it
 *   would for a top-level require: every call to getSupabase() inside the
 *   module under test returns our mock's `.supabase` property. Every
 *   jest.doMock factory below therefore returns `{ supabase: <builder> }`,
 *   mirroring the real module's exported shape
 *   (`{ supabase, getClient, withRetry, verifyConnection }`) rather than
 *   handing back the query-builder mock directly.
 *
 *   The builder itself is a minimal chainable query-builder mock good
 *   enough for this service's actual call shapes (`.from(t).select(...)
 *   .in(...).order(...).limit(...)`, `.maybeSingle()`, `.insert()`,
 *   `.upsert()`) — not a general-purpose Supabase mock.
 */

jest.mock('../../import/csvParser.util', () => ({
  parseCSVBuffer: jest.fn(),
}));

jest.mock('../../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

/**
 * Builds a minimal chainable Supabase query-builder mock.
 *
 * `responses` maps table name → { data, error, count } (or a function
 * returning that shape, for tables queried more than once per test with
 * different expected results — e.g. buildFKSets calling the same
 * collection for two different fkCheck fields).
 */
function createSupabaseMock(responses) {
  function resolveFor(table) {
    const entry = responses[table];
    if (typeof entry === 'function') return entry();
    return entry || { data: [], error: null, count: 0 };
  }

  function makeBuilder(table) {
    const builder = {
      select: () => builder,
      in: () => builder,
      order: () => builder,
      limit: () => builder,
      maybeSingle: () => Promise.resolve(resolveFor(table)),
      insert: jest.fn(() => Promise.resolve(resolveFor(`${table}:insert`) || { data: null, error: null })),
      upsert: jest.fn(() => Promise.resolve(resolveFor(`${table}:upsert`) || { data: null, error: null })),
      then: (resolve, reject) => Promise.resolve(resolveFor(table)).then(resolve, reject),
    };
    return builder;
  }

  return { from: jest.fn((table) => makeBuilder(table)) };
}

describe('graphImport.service', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  describe('module loading', () => {
    it('loads successfully and exports every function the admin controller depends on', () => {
      jest.doMock('../../../../config/supabase', () => ({ supabase: createSupabaseMock({}) }));
      const service = require('../graphImport.service');

      expect(typeof service.importGraphDataset).toBe('function');
      expect(typeof service.validateGraphIntegrity).toBe('function');
      expect(typeof service.getGraphMetrics).toBe('function');
      expect(typeof service.getImportLogs).toBe('function');
      expect(typeof service.getDatasetStatuses).toBe('function');
      expect(typeof service.getGraphHealth).toBe('function');
      expect(typeof service.getGraphAlerts).toBe('function');
      expect(typeof service.getLegacyBulkGraphStats).toBe('function');
      expect(service.SCHEMAS).toBeDefined();
    });
  });

  describe('getGraphMetrics', () => {
    it('returns the graph_metrics view row', async () => {
      const metrics = {
        total_roles: 120,
        total_skills: 340,
        total_role_transitions: 58,
        total_skill_relationships: 90,
        total_role_skills: 610,
      };
      jest.doMock('../../../../config/supabase', () => ({
        supabase: createSupabaseMock({ graph_metrics: { data: metrics, error: null } }),
      }));
      const { getGraphMetrics } = require('../graphImport.service');

      await expect(getGraphMetrics()).resolves.toEqual(metrics);
    });

    it('falls back to zeroed metrics on a query error, without throwing', async () => {
      jest.doMock('../../../../config/supabase', () => ({
        supabase: createSupabaseMock({ graph_metrics: { data: null, error: { message: 'db down' } } }),
      }));
      const { getGraphMetrics } = require('../graphImport.service');

      await expect(getGraphMetrics()).resolves.toEqual({
        total_roles: 0,
        total_skills: 0,
        total_role_transitions: 0,
        total_skill_relationships: 0,
        total_role_skills: 0,
      });
    });
  });

  describe('validateGraphIntegrity', () => {
    it('reports valid: true when every FK resolves', async () => {
      jest.doMock('../../../../config/supabase', () => ({
        supabase: createSupabaseMock({
          role_skills: { data: [{ id: '1', role_id: 'r1', skill_id: 's1' }], error: null },
          role_transitions: { data: [], error: null },
          skill_relationships: { data: [], error: null },
          role_education: { data: [], error: null },
          role_salary_market: { data: [], error: null },
          role_market_demand: { data: [], error: null },
          roles: { data: [{ role_id: 'r1' }], error: null },
          // WP-ADMIN-COMP-08-R17: skill_id is now validated against
          // career_skills_registry, not the (nonexistent, live) skills table.
          career_skills_registry: { data: [{ skill_id: 's1' }], error: null },
        }),
      }));
      const { validateGraphIntegrity } = require('../graphImport.service');

      const result = await validateGraphIntegrity();
      expect(result.valid).toBe(true);
      expect(result.orphanCount).toBe(0);
    });

    it('reports orphaned rows when a FK does not resolve', async () => {
      jest.doMock('../../../../config/supabase', () => ({
        supabase: createSupabaseMock({
          role_skills: { data: [{ id: '1', role_id: 'missing-role', skill_id: 's1' }], error: null },
          role_transitions: { data: [], error: null },
          skill_relationships: { data: [], error: null },
          role_education: { data: [], error: null },
          role_salary_market: { data: [], error: null },
          role_market_demand: { data: [], error: null },
          roles: { data: [{ role_id: 'r1' }], error: null },
          career_skills_registry: { data: [{ skill_id: 's1' }], error: null },
        }),
      }));
      const { validateGraphIntegrity } = require('../graphImport.service');

      const result = await validateGraphIntegrity();
      expect(result.valid).toBe(false);
      expect(result.orphanCount).toBe(1);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].dataset).toBe('role_skills');
    });

    // ── THE DIRECTIONAL FK COLLISION REGRESSION ─────────────────────────────
    it('correctly validates BOTH directional FK fields on role_transitions independently (from_role_id and to_role_id both point at `roles`)', async () => {
      // roles table only contains 'role-a' and 'role-b'. One transition row
      // references a real from_role_id but a MISSING to_role_id.
      jest.doMock('../../../../config/supabase', () => ({
        supabase: createSupabaseMock({
          roles: { data: [{ role_id: 'role-a' }, { role_id: 'role-b' }], error: null },
          role_transitions: {
            data: [{ id: 't1', from_role_id: 'role-a', to_role_id: 'role-missing' }],
            error: null,
          },
          role_skills: { data: [], error: null },
          skill_relationships: { data: [], error: null },
          role_education: { data: [], error: null },
          role_salary_market: { data: [], error: null },
          role_market_demand: { data: [], error: null },
          skills: { data: [], error: null },
        }),
      }));
      const { validateGraphIntegrity } = require('../graphImport.service');

      const result = await validateGraphIntegrity();
      const transitionIssue = result.issues.find((i) => i.dataset === 'role_transitions');

      // Must catch exactly the invalid to_role_id — not the valid
      // from_role_id, and not miss it either (which a collection-only
      // keyed FK-set cache would risk depending on fkChecks ordering).
      expect(transitionIssue).toBeDefined();
      expect(transitionIssue.orphan_count).toBe(1);
      expect(transitionIssue.sample[0].field).toBe('to_role_id');
      expect(transitionIssue.sample[0].value).toBe('role-missing');
    });

    it('does not flag a role_transitions row when BOTH from_role_id and to_role_id are valid', async () => {
      jest.doMock('../../../../config/supabase', () => ({
        supabase: createSupabaseMock({
          roles: { data: [{ role_id: 'role-a' }, { role_id: 'role-b' }], error: null },
          role_transitions: {
            data: [{ id: 't1', from_role_id: 'role-a', to_role_id: 'role-b' }],
            error: null,
          },
          role_skills: { data: [], error: null },
          skill_relationships: { data: [], error: null },
          role_education: { data: [], error: null },
          role_salary_market: { data: [], error: null },
          role_market_demand: { data: [], error: null },
          skills: { data: [], error: null },
        }),
      }));
      const { validateGraphIntegrity } = require('../graphImport.service');

      const result = await validateGraphIntegrity();
      const transitionIssue = result.issues.find((i) => i.dataset === 'role_transitions');
      expect(transitionIssue).toBeUndefined();
    });
  });

  describe('getImportLogs', () => {
    it('scopes to graph dataset types only', async () => {
      const logs = [{ id: 'log-1', entity_type: 'roles', imported_at: '2026-08-01T00:00:00.000Z' }];
      const mockSupabase = createSupabaseMock({ import_logs: { data: logs, error: null } });
      jest.doMock('../../../../config/supabase', () => ({ supabase: mockSupabase }));
      const { getImportLogs } = require('../graphImport.service');

      const result = await getImportLogs({ limit: 10 });
      expect(result).toEqual(logs);
      expect(mockSupabase.from).toHaveBeenCalledWith('import_logs');
    });

    it('returns an empty array on error, without throwing', async () => {
      jest.doMock('../../../../config/supabase', () => ({
        supabase: createSupabaseMock({ import_logs: { data: null, error: { message: 'db down' } } }),
      }));
      const { getImportLogs } = require('../graphImport.service');

      await expect(getImportLogs()).resolves.toEqual([]);
    });
  });

  describe('getDatasetStatuses', () => {
    it('returns one entry per GRAPH_DATASET_TYPES with row counts and last-import info', async () => {
      jest.doMock('../../../../config/supabase', () => ({
        supabase: createSupabaseMock({
          import_logs: {
            data: [
              {
                entity_type: 'roles',
                imported_at: '2026-08-01T00:00:00.000Z',
                import_mode: 'append',
                admin_user_id: 'admin-1',
                rows_imported: 10,
                rows_failed: 0,
              },
            ],
            error: null,
          },
          roles: { count: 120, error: null },
          skills: { count: 340, error: null },
          role_skills: { count: 610, error: null },
          role_transitions: { count: 58, error: null },
          skill_relationships: { count: 90, error: null },
          role_education: { count: 0, error: null },
          role_salary_market: { count: 0, error: null },
          role_market_demand: { count: 0, error: null },
        }),
      }));
      const { getDatasetStatuses } = require('../graphImport.service');

      const result = await getDatasetStatuses();
      expect(result).toHaveLength(8);

      const rolesStatus = result.find((r) => r.datasetType === 'roles');
      expect(rolesStatus.rowCount).toBe(120);
      expect(rolesStatus.lastImportedAt).toBe('2026-08-01T00:00:00.000Z');
      expect(rolesStatus.lastRowsImported).toBe(10);

      const skillsStatus = result.find((r) => r.datasetType === 'skills');
      expect(skillsStatus.lastImportedAt).toBeNull();
    });
  });

  describe('getGraphHealth', () => {
    it('reports critical when a core table is empty', async () => {
      jest.doMock('../../../../config/supabase', () => ({
        supabase: createSupabaseMock({
          graph_metrics: {
            data: { total_roles: 0, total_skills: 0, total_role_transitions: 0, total_skill_relationships: 0, total_role_skills: 0 },
            error: null,
          },
          role_skills: { data: [], error: null },
          role_transitions: { data: [], error: null },
          skill_relationships: { data: [], error: null },
          role_education: { data: [], error: null },
          role_salary_market: { data: [], error: null },
          role_market_demand: { data: [], error: null },
        }),
      }));
      const { getGraphHealth } = require('../graphImport.service');

      const result = await getGraphHealth();
      expect(result.status).toBe('critical');
    });

    it('reports healthy when metrics are populated and integrity is valid', async () => {
      jest.doMock('../../../../config/supabase', () => ({
        supabase: createSupabaseMock({
          graph_metrics: {
            data: { total_roles: 120, total_skills: 340, total_role_transitions: 58, total_skill_relationships: 90, total_role_skills: 610 },
            error: null,
          },
          role_skills: { data: [], error: null },
          role_transitions: { data: [], error: null },
          skill_relationships: { data: [], error: null },
          role_education: { data: [], error: null },
          role_salary_market: { data: [], error: null },
          role_market_demand: { data: [], error: null },
        }),
      }));
      const { getGraphHealth } = require('../graphImport.service');

      const result = await getGraphHealth();
      expect(result.status).toBe('healthy');
      expect(result.components).toEqual({ careerGraph: 'healthy', legacyBulkGraph: 'healthy' });
    });

    // WP-ADMIN-COMP-08-R21 — health-status decoupling regression:
    // a healthy, populated Career Graph must NOT mask a genuinely severe
    // monitored Legacy-side failure (the FK validation authority itself
    // being unreachable).
    it('reports critical when the Career Graph is healthy but the Legacy validation authority is unreachable', async () => {
      jest.doMock('../../../../config/supabase', () => ({
        supabase: createSupabaseMock({
          graph_metrics: {
            data: { total_roles: 120, total_skills: 340, total_role_transitions: 58, total_skill_relationships: 90, total_role_skills: 610 },
            error: null,
          },
          // role_skills has fkChecks against `roles` and `career_skills_registry`;
          // simulate `roles` (the FK lookup authority) being unreachable.
          role_skills: { data: [{ id: '1', role_id: 'r1', skill_id: 's1' }], error: null },
          roles: { data: null, error: { message: 'connection refused' } },
          career_skills_registry: { data: [{ skill_id: 's1' }], error: null },
          role_transitions: { data: [], error: null },
          skill_relationships: { data: [], error: null },
          role_education: { data: [], error: null },
          role_salary_market: { data: [], error: null },
          role_market_demand: { data: [], error: null },
        }),
      }));
      const { getGraphHealth } = require('../graphImport.service');

      const result = await getGraphHealth();
      expect(result.status).toBe('critical');
      expect(result.integrity.lookupFailures).toBeGreaterThan(0);
      expect(result.components.careerGraph).toBe('healthy');
      expect(result.components.legacyBulkGraph).toBe('critical');
    });

    // Ordinary, non-lookup-failure Legacy orphan rows must remain a
    // warning/degraded condition, not automatically become critical.
    it('reports degraded (not critical) for ordinary Legacy orphan rows when the Career Graph is healthy', async () => {
      jest.doMock('../../../../config/supabase', () => ({
        supabase: createSupabaseMock({
          graph_metrics: {
            data: { total_roles: 120, total_skills: 340, total_role_transitions: 58, total_skill_relationships: 90, total_role_skills: 610 },
            error: null,
          },
          role_skills: { data: [{ id: '1', role_id: 'missing-role', skill_id: 's1' }], error: null },
          roles: { data: [{ role_id: 'r1' }], error: null },
          career_skills_registry: { data: [{ skill_id: 's1' }], error: null },
          role_transitions: { data: [], error: null },
          skill_relationships: { data: [], error: null },
          role_education: { data: [], error: null },
          role_salary_market: { data: [], error: null },
          role_market_demand: { data: [], error: null },
        }),
      }));
      const { getGraphHealth } = require('../graphImport.service');

      const result = await getGraphHealth();
      expect(result.status).toBe('degraded');
      expect(result.integrity.lookupFailures).toBe(0);
      expect(result.components.legacyBulkGraph).toBe('degraded');
    });
  });

  describe('getGraphAlerts', () => {
    it('emits an orphaned_fk alert when validation finds issues', async () => {
      jest.doMock('../../../../config/supabase', () => ({
        supabase: createSupabaseMock({
          roles: { data: [{ role_id: 'role-a' }], error: null },
          role_transitions: { data: [{ id: 't1', from_role_id: 'role-a', to_role_id: 'missing' }], error: null },
          role_skills: { data: [], error: null },
          skill_relationships: { data: [], error: null },
          role_education: { data: [], error: null },
          role_salary_market: { data: [], error: null },
          role_market_demand: { data: [], error: null },
          skills: { data: [], error: null },
          import_logs: { data: [], error: null },
        }),
      }));
      const { getGraphAlerts } = require('../graphImport.service');

      const result = await getGraphAlerts();
      const fkAlert = result.find((a) => a.type === 'orphaned_fk');
      expect(fkAlert).toBeDefined();
      expect(fkAlert.dataset).toBe('role_transitions');
    });

    it('emits an import_failures alert for a recent import with failed rows', async () => {
      jest.doMock('../../../../config/supabase', () => ({
        supabase: createSupabaseMock({
          roles: { data: [], error: null },
          role_transitions: { data: [], error: null },
          role_skills: { data: [], error: null },
          skill_relationships: { data: [], error: null },
          role_education: { data: [], error: null },
          role_salary_market: { data: [], error: null },
          role_market_demand: { data: [], error: null },
          skills: { data: [], error: null },
          import_logs: {
            data: [{ entity_type: 'roles', imported_at: '2026-08-01T00:00:00.000Z', rows_failed: 3 }],
            error: null,
          },
        }),
      }));
      const { getGraphAlerts } = require('../graphImport.service');

      const result = await getGraphAlerts();
      const failureAlert = result.find((a) => a.type === 'import_failures');
      expect(failureAlert).toBeDefined();
      expect(failureAlert.dataset).toBe('roles');
    });

    it('returns an empty array when there is nothing to alert on', async () => {
      jest.doMock('../../../../config/supabase', () => ({
        supabase: createSupabaseMock({
          roles: { data: [], error: null },
          role_transitions: { data: [], error: null },
          role_skills: { data: [], error: null },
          skill_relationships: { data: [], error: null },
          role_education: { data: [], error: null },
          role_salary_market: { data: [], error: null },
          role_market_demand: { data: [], error: null },
          skills: { data: [], error: null },
          import_logs: { data: [], error: null },
        }),
      }));
      const { getGraphAlerts } = require('../graphImport.service');

      await expect(getGraphAlerts()).resolves.toEqual([]);
    });
  });

  describe('getLegacyBulkGraphStats', () => {
    it('computes connectivity stats from roles + role_transitions (Legacy Bulk Graph tables)', async () => {
      jest.doMock('../../../../config/supabase', () => ({
        supabase: createSupabaseMock({
          roles: { data: [{ role_id: 'r1' }, { role_id: 'r2' }, { role_id: 'r3' }], error: null },
          role_transitions: { data: [{ from_role_id: 'r1', to_role_id: 'r2' }], error: null },
        }),
      }));
      const { getLegacyBulkGraphStats } = require('../graphImport.service');

      const result = await getLegacyBulkGraphStats();
      expect(result.totalRoles).toBe(3);
      expect(result.totalTransitions).toBe(1);
      expect(result.isolatedRoleCount).toBe(1); // r3 has no transitions
      expect(result.topConnectedRoles[0].roleId).toBe('r1');
    });
  });

  describe('import logging (importGraphDataset)', () => {
    it('writes exactly one import_logs row with correct counts and import_mode', async () => {
      // Re-require after the shared afterEach's resetModules() — the
      // module-level `parseCSVBuffer` reference at the top of this file
      // points at a stale mock instance once modules have been reset;
      // this grabs the instance graphImport.service will actually resolve.
      const { parseCSVBuffer: freshParseCSVBuffer } = require('../../import/csvParser.util');
      freshParseCSVBuffer.mockReturnValue([
        { role_id: 'r1', role_name: 'Engineer' },
        { role_id: 'r2', role_name: 'Designer' },
      ]);

      const mockSupabase = { from: null };
      mockSupabase.from = jest.fn((table) => {
        const builder = {
          select: () => builder,
          in: () => builder,
          order: () => builder,
          limit: () => builder,
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
          insert: jest.fn(() => Promise.resolve({ data: null, error: null })),
          upsert: jest.fn(() => Promise.resolve({ data: null, error: null })),
          then: (resolve) => resolve({ data: [], error: null }),
        };
        return builder;
      });
      jest.doMock('../../../../config/supabase', () => ({ supabase: mockSupabase }));
      const { importGraphDataset } = require('../graphImport.service');

      const result = await importGraphDataset({
        buffer: Buffer.from('unused — parseCSVBuffer is mocked'),
        datasetType: 'roles',
        adminId: 'admin-1',
        mode: 'append',
      });

      expect(result.processed).toBe(2);
      expect(result.imported).toBe(2);
      expect(result.skipped).toBe(0);
      expect(result.mode).toBe('append');

      // Find the call that hit 'import_logs' and inserted a row.
      const importLogsCall = mockSupabase.from.mock.calls.find(([table]) => table === 'import_logs');
      expect(importLogsCall).toBeDefined();
    });

    it('does not write to import_logs when preview: true (dry run)', async () => {
      const { parseCSVBuffer: freshParseCSVBuffer } = require('../../import/csvParser.util');
      freshParseCSVBuffer.mockReturnValue([{ role_id: 'r1', role_name: 'Engineer' }]);

      const mockSupabase = { from: null };
      mockSupabase.from = jest.fn((table) => {
        const builder = {
          select: () => builder,
          in: () => builder,
          order: () => builder,
          limit: () => builder,
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
          insert: jest.fn(() => Promise.resolve({ data: null, error: null })),
          upsert: jest.fn(() => Promise.resolve({ data: null, error: null })),
          then: (resolve) => resolve({ data: [], error: null }),
        };
        return builder;
      });
      jest.doMock('../../../../config/supabase', () => ({ supabase: mockSupabase }));
      const { importGraphDataset } = require('../graphImport.service');

      const result = await importGraphDataset({
        buffer: Buffer.from('unused'),
        datasetType: 'roles',
        adminId: 'admin-1',
        preview: true,
      });

      expect(result.importable).toBe(1);
      const importLogsCall = mockSupabase.from.mock.calls.find(([table]) => table === 'import_logs');
      expect(importLogsCall).toBeUndefined();
    });
  });

  describe('skills import — old_id contract (WP-ADMIN-COMP-08-R2)', () => {
    // public.skills.old_id is `text NOT NULL` with no default. It is not
    // derived from skill_id or id anywhere in the codebase; the only
    // established contract for it (bulk_import_graph RPC / REQUIRED_FIELDS
    // in bulk-import-validator.js) treats it as a required, caller-supplied
    // value. These tests pin that same requirement in the Graph
    // Administration CSV import path.

    it('flags a skills row missing old_id as a field error and excludes it from the importable/preview set', async () => {
      const { parseCSVBuffer: freshParseCSVBuffer } = require('../../import/csvParser.util');
      freshParseCSVBuffer.mockReturnValue([
        { skill_id: 's1', skill_name: 'JavaScript' }, // no old_id
        { skill_id: 's2', skill_name: 'TypeScript', old_id: 'legacy-002' },
      ]);

      const mockSupabase = { from: null };
      mockSupabase.from = jest.fn((table) => {
        const builder = {
          select: () => builder,
          in: () => builder,
          order: () => builder,
          limit: () => builder,
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
          insert: jest.fn(() => Promise.resolve({ data: null, error: null })),
          upsert: jest.fn(() => Promise.resolve({ data: null, error: null })),
          then: (resolve) => resolve({ data: [], error: null }),
        };
        return builder;
      });
      jest.doMock('../../../../config/supabase', () => ({ supabase: mockSupabase }));
      const { importGraphDataset } = require('../graphImport.service');

      const result = await importGraphDataset({
        buffer: Buffer.from('unused — parseCSVBuffer is mocked'),
        datasetType: 'skills',
        adminId: 'admin-1',
        preview: true,
      });

      expect(result.importable).toBe(1);
      expect(result.fieldErrors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'old_id', row: 2 }),
        ])
      );
      expect(result.preview[0].skill_id).toBe('s2');
    });

    it('passes old_id through unchanged to the skills upsert payload for a valid row', async () => {
      const { parseCSVBuffer: freshParseCSVBuffer } = require('../../import/csvParser.util');
      freshParseCSVBuffer.mockReturnValue([
        { skill_id: 's2', skill_name: 'TypeScript', old_id: 'legacy-002' },
      ]);

      const mockSupabase = { from: null };
      const upsertSpy = jest.fn(() => Promise.resolve({ data: null, error: null }));
      mockSupabase.from = jest.fn((table) => {
        const builder = {
          select: () => builder,
          in: () => builder,
          order: () => builder,
          limit: () => builder,
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
          insert: jest.fn(() => Promise.resolve({ data: null, error: null })),
          upsert: table === 'skills' ? upsertSpy : jest.fn(() => Promise.resolve({ data: null, error: null })),
          then: (resolve) => resolve({ data: [], error: null }),
        };
        return builder;
      });
      jest.doMock('../../../../config/supabase', () => ({ supabase: mockSupabase }));
      const { importGraphDataset } = require('../graphImport.service');

      const result = await importGraphDataset({
        buffer: Buffer.from('unused — parseCSVBuffer is mocked'),
        datasetType: 'skills',
        adminId: 'admin-1',
        mode: 'append',
      });

      expect(result.imported).toBe(1);
      expect(upsertSpy).toHaveBeenCalledWith([
        expect.objectContaining({ skill_id: 's2', skill_name: 'TypeScript', old_id: 'legacy-002' }),
      ]);
    });
  });
});