'use strict';

/**
 * @file graphImport.service.r22.test.js
 * @description WP-ADMIN-COMP-08-R22 focused tests — Roles CSV Replace
 * Semantics & Composite-Key Conflict Resolution.
 *
 * Covers the required test matrix from the R22 work package (§9):
 *   9.1 — Replace succeeds against a composite_key conflict (no longer
 *         raises "duplicate key value violates unique constraint
 *         uq_roles_composite_key").
 *   9.2 — Append is unchanged: it still goes through the plain
 *         .from('roles').upsert(...) path (no silent overwrite behavior
 *         introduced by this WP).
 *   9.3 — Replace atomic failure: a chunk whose RPC call fails reports a
 *         write error and does not increment `imported` — no partial
 *         result is reported as a success.
 *   9.4 — Preview never writes, in either mode (neither .upsert() nor the
 *         new .rpc('replace_import_roles', ...) is called during preview).
 *   9.5 — Import result accuracy: processed/imported/skipped/errorCount
 *         reflect what replace_import_roles() actually reported.
 *   9.6 — Import history: logImportEvent still records the correct mode
 *         and counts for a Replace import.
 *   9.7 — Special name cases reach the RPC with the exact composite-key
 *         inputs from R22 §8 (role_name/role_family only — composite_key
 *         itself is DB-generated and is not sent by the application).
 *
 * MOCKING STRATEGY: mirrors graphImport.service.test.js / .r18.test.js —
 * getSupabase() is a lazy require, so jest.doMock('.../config/supabase', …)
 * intercepts every call inside the module under test.
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

function makeMockSupabase({ rpcImpl, upsertImpl, insertImpl } = {}) {
  const rpcSpy = jest.fn(
    rpcImpl ||
      (() => Promise.resolve({ data: { inserted: 1, updated: 0, replaced: 0, total: 1 }, error: null }))
  );
  const upsertSpy = jest.fn(upsertImpl || (() => Promise.resolve({ data: null, error: null })));
  const insertSpy = jest.fn(insertImpl || (() => Promise.resolve({ data: null, error: null })));

  const mockSupabase = { from: null, rpc: rpcSpy, rpcSpy, upsertSpy, insertSpy };

  mockSupabase.from = jest.fn((table) => {
    const builder = {
      select: () => builder,
      in: () => builder,
      order: () => builder,
      limit: () => builder,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      insert: table === 'import_logs' ? insertSpy : jest.fn(() => Promise.resolve({ data: null, error: null })),
      upsert: table === 'roles' ? upsertSpy : jest.fn(() => Promise.resolve({ data: null, error: null })),
      then: (resolve) => resolve({ data: [], error: null }),
    };
    return builder;
  });

  return mockSupabase;
}

describe('WP-ADMIN-COMP-08-R22 — Roles CSV Replace semantics', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  describe('9.1 — Replace succeeds against an existing composite_key conflict', () => {
    it('does not surface a uq_roles_composite_key duplicate-key error and reports the row imported', async () => {
      const { parseCSVBuffer } = require('../../import/csvParser.util');
      parseCSVBuffer.mockReturnValue([
        { role_id: 'new-role-id-999', role_name: 'Software Engineer', role_family: 'Engineering' },
      ]);

      // The RPC is what actually reconciles the conflicting active row —
      // from the caller's point of view a successful RPC response with no
      // `error` IS "no duplicate-key violation reached the caller".
      const mockSupabase = makeMockSupabase({
        rpcImpl: () =>
          Promise.resolve({
            data: { inserted: 1, updated: 0, replaced: 1, total: 1 },
            error: null,
          }),
      });
      jest.doMock('../../../../config/supabase', () => ({ supabase: mockSupabase }));
      const { importGraphDataset } = require('../graphImport.service');

      const result = await importGraphDataset({
        buffer: Buffer.from('unused'),
        datasetType: 'roles',
        adminId: 'admin-1',
        mode: 'replace',
      });

      expect(result.writeErrors).toEqual([]);
      expect(result.imported).toBe(1);
      expect(result.replaced).toBe(1);
      expect(result.errorCount).toBe(0);
      expect(mockSupabase.upsertSpy).not.toHaveBeenCalled();
      expect(mockSupabase.rpcSpy).toHaveBeenCalledWith(
        'replace_import_roles',
        expect.objectContaining({
          p_rows: [
            expect.objectContaining({
              role_id: 'new-role-id-999',
              role_name: 'Software Engineer',
              role_family: 'Engineering',
            }),
          ],
        })
      );
    });
  });

  describe('9.2 — Append continues to respect uniqueness (unchanged)', () => {
    it('still writes via the plain roles upsert, and a write failure is reported (not silently overwritten)', async () => {
      const { parseCSVBuffer } = require('../../import/csvParser.util');
      parseCSVBuffer.mockReturnValue([
        { role_id: 'r1', role_name: 'Software Engineer', role_family: 'Engineering' },
      ]);

      const mockSupabase = makeMockSupabase({
        upsertImpl: () =>
          Promise.resolve({
            data: null,
            error: { message: 'duplicate key value violates unique constraint "uq_roles_composite_key"' },
          }),
      });
      jest.doMock('../../../../config/supabase', () => ({ supabase: mockSupabase }));
      const { importGraphDataset } = require('../graphImport.service');

      const result = await importGraphDataset({
        buffer: Buffer.from('unused'),
        datasetType: 'roles',
        adminId: 'admin-1',
        mode: 'append',
      });

      expect(mockSupabase.rpcSpy).not.toHaveBeenCalled();
      expect(mockSupabase.upsertSpy).toHaveBeenCalled();
      expect(result.imported).toBe(0);
      expect(result.writeErrors).toHaveLength(1);
      expect(result.writeErrors[0].message).toMatch(/uq_roles_composite_key/);
      expect(result.replaced).toBeUndefined();
    });
  });

  describe('9.3 — Replace atomic failure reports no partial success', () => {
    it('a failed replace_import_roles RPC call is reported as a write error, not a partial import', async () => {
      const { parseCSVBuffer } = require('../../import/csvParser.util');
      parseCSVBuffer.mockReturnValue([
        { role_id: 'r1', role_name: 'Software Engineer', role_family: 'Engineering' },
        { role_id: 'r2', role_name: 'Data Scientist', role_family: 'Data' },
      ]);

      const mockSupabase = makeMockSupabase({
        rpcImpl: () =>
          Promise.resolve({
            data: null,
            error: { message: 'replace_import_roles: unexpected failure' },
          }),
      });
      jest.doMock('../../../../config/supabase', () => ({ supabase: mockSupabase }));
      const { importGraphDataset } = require('../graphImport.service');

      const result = await importGraphDataset({
        buffer: Buffer.from('unused'),
        datasetType: 'roles',
        adminId: 'admin-1',
        mode: 'replace',
      });

      // Because the RPC body itself is atomic per call (an unhandled
      // exception rolls back everything the function attempted), a
      // reported error here means nothing from this chunk was committed —
      // `imported` for this chunk must stay at 0, never a partial count.
      expect(result.imported).toBe(0);
      expect(result.writeErrors).toHaveLength(1);
      expect(result.writeErrors[0].type).toBe('write');
    });
  });

  describe('9.4 — Preview never writes', () => {
    it('preview in replace mode calls neither .upsert() nor .rpc()', async () => {
      const { parseCSVBuffer } = require('../../import/csvParser.util');
      parseCSVBuffer.mockReturnValue([
        { role_id: 'r1', role_name: 'Software Engineer', role_family: 'Engineering' },
      ]);

      const mockSupabase = makeMockSupabase();
      jest.doMock('../../../../config/supabase', () => ({ supabase: mockSupabase }));
      const { importGraphDataset } = require('../graphImport.service');

      const result = await importGraphDataset({
        buffer: Buffer.from('unused'),
        datasetType: 'roles',
        adminId: 'admin-1',
        mode: 'replace',
        preview: true,
      });

      expect(result.importable).toBe(1);
      expect(mockSupabase.upsertSpy).not.toHaveBeenCalled();
      expect(mockSupabase.rpcSpy).not.toHaveBeenCalled();
    });

    it('preview in append mode also writes nothing', async () => {
      const { parseCSVBuffer } = require('../../import/csvParser.util');
      parseCSVBuffer.mockReturnValue([{ role_id: 'r1', role_name: 'Software Engineer' }]);

      const mockSupabase = makeMockSupabase();
      jest.doMock('../../../../config/supabase', () => ({ supabase: mockSupabase }));
      const { importGraphDataset } = require('../graphImport.service');

      await importGraphDataset({
        buffer: Buffer.from('unused'),
        datasetType: 'roles',
        adminId: 'admin-1',
        mode: 'append',
        preview: true,
      });

      expect(mockSupabase.upsertSpy).not.toHaveBeenCalled();
      expect(mockSupabase.rpcSpy).not.toHaveBeenCalled();
    });
  });

  describe('9.5 — Import result accuracy', () => {
    it('distinguishes processed/imported/skipped/errorCount for a mixed valid+invalid Replace batch', async () => {
      const { parseCSVBuffer } = require('../../import/csvParser.util');
      parseCSVBuffer.mockReturnValue([
        { role_id: 'r1', role_name: 'Software Engineer', role_family: 'Engineering' }, // valid
        { role_id: '', role_name: 'Missing Id' }, // invalid: missing required role_id
      ]);

      const mockSupabase = makeMockSupabase({
        rpcImpl: () =>
          Promise.resolve({ data: { inserted: 1, updated: 0, replaced: 0, total: 1 }, error: null }),
      });
      jest.doMock('../../../../config/supabase', () => ({ supabase: mockSupabase }));
      const { importGraphDataset } = require('../graphImport.service');

      const result = await importGraphDataset({
        buffer: Buffer.from('unused'),
        datasetType: 'roles',
        adminId: 'admin-1',
        mode: 'replace',
      });

      expect(result.processed).toBe(2);
      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.fieldErrors).toHaveLength(1);
      expect(result.errorCount).toBe(1);
    });
  });

  describe('9.6 — Import history', () => {
    it('writes exactly one import_logs row recording mode "replace" and the RPC-reported counts', async () => {
      const { parseCSVBuffer } = require('../../import/csvParser.util');
      parseCSVBuffer.mockReturnValue([
        { role_id: 'r1', role_name: 'Software Engineer', role_family: 'Engineering' },
      ]);

      const mockSupabase = makeMockSupabase({
        rpcImpl: () =>
          Promise.resolve({ data: { inserted: 0, updated: 1, replaced: 1, total: 1 }, error: null }),
      });
      jest.doMock('../../../../config/supabase', () => ({ supabase: mockSupabase }));
      const { importGraphDataset } = require('../graphImport.service');

      await importGraphDataset({
        buffer: Buffer.from('unused'),
        datasetType: 'roles',
        adminId: 'admin-1',
        mode: 'replace',
      });

      expect(mockSupabase.insertSpy).toHaveBeenCalledTimes(1);
      const loggedRow = mockSupabase.insertSpy.mock.calls[0][0];
      expect(loggedRow.import_mode).toBe('replace');
      expect(loggedRow.rows_imported).toBe(1);
      expect(loggedRow.rows_processed).toBe(1);
      expect(loggedRow.rows_failed).toBe(0);
    });
  });

  describe('9.7 — Special name cases reach the RPC with the source role_name/role_family', () => {
    it.each([
      ['C++ Developer', 'Engineering'],
      ['Node.js Engineer', 'Engineering'],
      ['R&D Manager', 'Research'],
      ['Café Operations Manager', 'Operations'],
      ['Staff   Engineer', 'Engineering'],
    ])('replaces %s / %s without altering role_name/role_family (composite_key is DB-generated)', async (roleName, roleFamily) => {
      const { parseCSVBuffer } = require('../../import/csvParser.util');
      parseCSVBuffer.mockReturnValue([
        { role_id: 'incoming-id', role_name: roleName, role_family: roleFamily },
      ]);

      const mockSupabase = makeMockSupabase({
        rpcImpl: () =>
          Promise.resolve({ data: { inserted: 1, updated: 0, replaced: 1, total: 1 }, error: null }),
      });
      jest.doMock('../../../../config/supabase', () => ({ supabase: mockSupabase }));
      const { importGraphDataset } = require('../graphImport.service');

      const result = await importGraphDataset({
        buffer: Buffer.from('unused'),
        datasetType: 'roles',
        adminId: 'admin-1',
        mode: 'replace',
      });

      expect(result.writeErrors).toEqual([]);
      const [, rpcArgs] = mockSupabase.rpcSpy.mock.calls[0];
      // graphImport.service.js never rewrites role_name/role_family — the
      // RPC computes composite_key itself from these exact values, so
      // preview and write always agree on the same identity.
      expect(rpcArgs.p_rows[0].role_name).toBe(roleName);
      expect(rpcArgs.p_rows[0].role_family).toBe(roleFamily);
      expect(typeof rpcArgs.p_rows[0].normalized_name).toBe('string');
      expect(rpcArgs.p_rows[0].normalized_name.length).toBeGreaterThan(0);
    });
  });
});
