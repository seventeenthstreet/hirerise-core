'use strict';

/**
 * @file graphImport.service.r18.test.js
 * @description WP-ADMIN-COMP-08-R18 focused tests.
 *
 * Covers:
 *   T1 — a valid Roles CSV row previews as importable.
 *   T2 — the same row reaches the write path with a non-null
 *        normalized_name and writes successfully.
 *   T3 — preview and the actual upsert payload use the identical
 *        normalization (same value both places).
 *   T4 — Replace mode.
 *   T5 — Append mode.
 *   T6 — a row missing role_name (so normalized_name is unusable) is not
 *        incorrectly marked importable.
 *   T7 — no R17 regression: career_skills_registry remains the skill
 *        authority, public.skills is not reintroduced, lookup-failure
 *        semantics are unaffected by this change.
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

function makeMockSupabase({ upsertError = null, rpcError = null, rpcResult = null } = {}) {
  const upsertSpy = jest.fn(() => Promise.resolve({ data: null, error: upsertError }));
  // WP-ADMIN-COMP-08-R22: Roles + Replace no longer calls
  // .from('roles').upsert(...) — it calls the replace_import_roles() RPC.
  // Tests that exercise replace mode assert against rpcSpy instead.
  const rpcSpy = jest.fn(() =>
    Promise.resolve({ data: rpcResult, error: rpcError })
  );
  const mockSupabase = { from: null, rpc: rpcSpy, upsertSpy, rpcSpy };

  mockSupabase.from = jest.fn((table) => {
    const builder = {
      select: () => builder,
      in: () => builder,
      order: () => builder,
      limit: () => builder,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      insert: jest.fn(() => Promise.resolve({ data: null, error: null })),
      upsert: table === 'roles' ? upsertSpy : jest.fn(() => Promise.resolve({ data: null, error: null })),
      then: (resolve) => resolve({ data: [], error: null }),
    };
    return builder;
  });

  return mockSupabase;
}

describe('WP-ADMIN-COMP-08-R18 — Roles CSV normalized_name write-path fix', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  describe('T1 — valid Roles CSV preview', () => {
    it('reports the row as importable', async () => {
      const { parseCSVBuffer } = require('../../import/csvParser.util');
      parseCSVBuffer.mockReturnValue([
        { role_id: 'r1', role_name: 'Senior Software Engineer' },
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
      expect(result.fieldErrors).toEqual([]);
      // Preview already reflects the value the write path will use.
      expect(result.preview[0].normalized_name).toBe('senior software engineer');
    });
  });

  describe('T2 — valid Roles CSV import reaches the write path with a non-null normalized_name', () => {
    it('writes successfully with normalized_name populated', async () => {
      const { parseCSVBuffer } = require('../../import/csvParser.util');
      parseCSVBuffer.mockReturnValue([
        { role_id: 'r1', role_name: 'Senior Software Engineer' },
      ]);

      const mockSupabase = makeMockSupabase();
      jest.doMock('../../../../config/supabase', () => ({ supabase: mockSupabase }));
      const { importGraphDataset } = require('../graphImport.service');

      const result = await importGraphDataset({
        buffer: Buffer.from('unused'),
        datasetType: 'roles',
        adminId: 'admin-1',
        mode: 'append',
      });

      expect(result.imported).toBe(1);
      expect(result.writeErrors).toEqual([]);
      expect(mockSupabase.upsertSpy).toHaveBeenCalledWith([
        expect.objectContaining({
          role_id: 'r1',
          role_name: 'Senior Software Engineer',
          normalized_name: 'senior software engineer',
        }),
      ]);
      // The exact failure this WP fixes must not recur.
      const payload = mockSupabase.upsertSpy.mock.calls[0][0][0];
      expect(payload.normalized_name).not.toBeNull();
      expect(payload.normalized_name).not.toBe('');
    });
  });

  describe('T3 — normalization consistency between preview and write', () => {
    it('uses the identical normalized_name value in preview and in the upsert payload', async () => {
      const rows = [{ role_id: 'r1', role_name: '  Staff   Engineer  ' }];

      const { parseCSVBuffer } = require('../../import/csvParser.util');
      parseCSVBuffer.mockReturnValue(rows);
      const mockSupabase1 = makeMockSupabase();
      jest.doMock('../../../../config/supabase', () => ({ supabase: mockSupabase1 }));
      const { importGraphDataset: importPreview } = require('../graphImport.service');

      const previewResult = await importPreview({
        buffer: Buffer.from('unused'),
        datasetType: 'roles',
        adminId: 'admin-1',
        preview: true,
      });

      jest.resetModules();
      const { parseCSVBuffer: freshParseCSVBuffer } = require('../../import/csvParser.util');
      freshParseCSVBuffer.mockReturnValue(rows);
      const mockSupabase2 = makeMockSupabase();
      jest.doMock('../../../../config/supabase', () => ({ supabase: mockSupabase2 }));
      const { importGraphDataset: importWrite } = require('../graphImport.service');

      await importWrite({
        buffer: Buffer.from('unused'),
        datasetType: 'roles',
        adminId: 'admin-1',
      });

      const writtenValue = mockSupabase2.upsertSpy.mock.calls[0][0][0].normalized_name;
      expect(previewResult.preview[0].normalized_name).toBe(writtenValue);
      expect(writtenValue).toBe('staff engineer');
    });
  });

  describe('T4 — Replace mode', () => {
    it('populates normalized_name on the replace_import_roles RPC payload, not the plain upsert path', async () => {
      // WP-ADMIN-COMP-08-R22: Roles + Replace now calls the dedicated
      // replace_import_roles() RPC instead of .from('roles').upsert(...) —
      // see graphImport.service.js and the R22 migration. This supersedes
      // the pre-R22 assumption (that Replace and Append reached the same
      // upsert call) which was itself the root cause of R22's defect.
      const { parseCSVBuffer } = require('../../import/csvParser.util');
      parseCSVBuffer.mockReturnValue([{ role_id: 'r1', role_name: 'Product Manager' }]);

      const mockSupabase = makeMockSupabase({
        rpcResult: { inserted: 1, updated: 0, replaced: 0, total: 1 },
      });
      jest.doMock('../../../../config/supabase', () => ({ supabase: mockSupabase }));
      const { importGraphDataset } = require('../graphImport.service');

      const result = await importGraphDataset({
        buffer: Buffer.from('unused'),
        datasetType: 'roles',
        adminId: 'admin-1',
        mode: 'replace',
      });

      expect(result.imported).toBe(1);
      expect(result.mode).toBe('replace');
      expect(mockSupabase.upsertSpy).not.toHaveBeenCalled();
      expect(mockSupabase.rpcSpy).toHaveBeenCalledWith('replace_import_roles', {
        p_rows: [expect.objectContaining({ normalized_name: 'product manager' })],
      });
    });
  });

  describe('T5 — Append mode', () => {
    it('populates normalized_name on the write path in append mode', async () => {
      const { parseCSVBuffer } = require('../../import/csvParser.util');
      parseCSVBuffer.mockReturnValue([{ role_id: 'r1', role_name: 'Product Manager' }]);

      const mockSupabase = makeMockSupabase();
      jest.doMock('../../../../config/supabase', () => ({ supabase: mockSupabase }));
      const { importGraphDataset } = require('../graphImport.service');

      const result = await importGraphDataset({
        buffer: Buffer.from('unused'),
        datasetType: 'roles',
        adminId: 'admin-1',
        mode: 'append',
      });

      expect(result.imported).toBe(1);
      expect(result.mode).toBe('append');
      expect(mockSupabase.upsertSpy).toHaveBeenCalledWith([
        expect.objectContaining({ normalized_name: 'product manager' }),
      ]);
    });
  });

  describe('T6 — missing role_name', () => {
    it('does not mark a row with no role_name as importable', async () => {
      const { parseCSVBuffer } = require('../../import/csvParser.util');
      parseCSVBuffer.mockReturnValue([
        { role_id: 'r1' }, // no role_name — required field is already enforced
        { role_id: 'r2', role_name: 'Data Analyst' },
      ]);

      const mockSupabase = makeMockSupabase();
      jest.doMock('../../../../config/supabase', () => ({ supabase: mockSupabase }));
      const { importGraphDataset } = require('../graphImport.service');

      const result = await importGraphDataset({
        buffer: Buffer.from('unused'),
        datasetType: 'roles',
        adminId: 'admin-1',
        preview: true,
      });

      expect(result.importable).toBe(1);
      expect(result.fieldErrors).toEqual([
        expect.objectContaining({ row: 2, field: 'role_name' }),
      ]);
      expect(result.preview[0].role_id).toBe('r2');
    });
  });

  describe('T7 — no R17 regression', () => {
    it('SCHEMAS.role_skills.skill_id still authorizes against career_skills_registry', () => {
      jest.doMock('../../../../config/supabase', () => ({ supabase: makeMockSupabase() }));
      const { SCHEMAS } = require('../graphImport.service');

      const skillCheck = SCHEMAS.role_skills.fkChecks.find((c) => c.field === 'skill_id');
      expect(skillCheck.collection).toBe('career_skills_registry');
      expect(skillCheck.column).toBe('skill_id');

      const relCheck = SCHEMAS.skill_relationships.fkChecks.find((c) => c.field === 'related_skill_id');
      expect(relCheck.collection).toBe('career_skills_registry');

      // public.skills must not be reintroduced as an FK authority anywhere.
      const allFkCollections = Object.values(SCHEMAS)
        .flatMap((s) => s.fkChecks || [])
        .map((c) => c.collection);
      expect(allFkCollections).not.toContain('skills');
    });

    it('lookup-failure semantics from R17 remain intact', async () => {
      const mockSupabase = makeMockSupabase();
      mockSupabase.from = jest.fn((table) => {
        const builder = {
          select: () => builder,
          in: () => builder,
          then: (resolve, reject) => {
            if (table === 'career_skills_registry') {
              return Promise.resolve({ data: null, error: { message: 'db down' } }).then(resolve, reject);
            }
            if (table === 'roles') {
              return Promise.resolve({ data: [{ role_id: 'r1' }], error: null }).then(resolve, reject);
            }
            return Promise.resolve({ data: [], error: null }).then(resolve, reject);
          },
        };
        return builder;
      });
      jest.doMock('../../../../config/supabase', () => ({ supabase: mockSupabase }));
      const { buildFKSets, detectFKErrors, SCHEMAS } = require('../graphImport.service');

      const rows = [{ __rowNum: 2, role_id: 'r1', skill_id: 's1' }];
      const fkSets = await buildFKSets(rows, SCHEMAS.role_skills.fkChecks);
      const errors = detectFKErrors(rows, SCHEMAS.role_skills, fkSets);

      expect(errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'skill_id', type: 'fk_lookup_failed' }),
        ])
      );
      expect(errors.some((e) => e.field === 'skill_id' && e.type === 'fk')).toBe(false);
    });
  });
});
