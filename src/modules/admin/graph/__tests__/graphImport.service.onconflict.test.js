'use strict';

/**
 * @file graphImport.service.onconflict.test.js
 * @description WP-ADMIN-COMP-08 Graph Phase 4 — confirmed onConflict gap.
 *
 *   The ordinary Append upsert path (`supabase.from(collection).upsert(...)`)
 *   previously passed no `onConflict` target at all. This pinned every
 *   dataset's actual conflict target — each verified against a real live
 *   unique index in the schema (see APPEND_ON_CONFLICT in
 *   graphImport.service.js) — and confirms the dedicated
 *   replace_import_roles() RPC path for roles Replace remains untouched by
 *   this change (still no onConflict-based upsert involved).
 *
 * MOCKING STRATEGY: same minimal chainable Supabase builder pattern as
 * graphImport.service.test.js — `${table}` responses answer FK-check
 * lookups (`.select(col).in(col, values)`), `${table}:upsert` answers the
 * write call.
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

function createSupabaseMock(responses) {
  function resolveFor(table) {
    const entry = responses[table];
    if (typeof entry === 'function') return entry();
    return entry || { data: [], error: null, count: 0 };
  }

  const upsertSpies = {};

  function makeBuilder(table) {
    upsertSpies[table] =
      upsertSpies[table] ||
      jest.fn(() => Promise.resolve(resolveFor(`${table}:upsert`) || { data: null, error: null }));

    const builder = {
      select: () => builder,
      in: () => builder,
      order: () => builder,
      limit: () => builder,
      maybeSingle: () => Promise.resolve(resolveFor(table)),
      insert: jest.fn(() => Promise.resolve(resolveFor(`${table}:insert`) || { data: null, error: null })),
      upsert: upsertSpies[table],
      then: (resolve, reject) => Promise.resolve(resolveFor(table)).then(resolve, reject),
    };
    return builder;
  }

  return { from: jest.fn((table) => makeBuilder(table)), upsertSpies };
}

describe('graphImport.service — onConflict matrix (WP-ADMIN-COMP-08 Graph Phase 4)', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  it('roles Append — onConflict: role_id', async () => {
    const { parseCSVBuffer } = require('../../import/csvParser.util');
    parseCSVBuffer.mockReturnValue([{ role_id: 'r1', role_name: 'Engineer' }]);

    const mockSupabase = createSupabaseMock({});
    jest.doMock('../../../../config/supabase', () => ({ supabase: mockSupabase }));
    const { importGraphDataset } = require('../graphImport.service');

    const result = await importGraphDataset({
      buffer: Buffer.from('unused'),
      datasetType: 'roles',
      adminId: 'admin-1',
      mode: 'append',
    });

    expect(result.imported).toBe(1);
    expect(mockSupabase.upsertSpies.roles).toHaveBeenCalledWith(
      expect.any(Array),
      { onConflict: 'role_id' }
    );
  });

  it('roles Replace — still calls replace_import_roles() RPC, not the ordinary upsert path', async () => {
    const { parseCSVBuffer } = require('../../import/csvParser.util');
    parseCSVBuffer.mockReturnValue([{ role_id: 'r1', role_name: 'Engineer' }]);

    const mockSupabase = createSupabaseMock({});
    mockSupabase.rpc = jest.fn(() =>
      Promise.resolve({ data: { inserted: 1, updated: 0, replaced: 0, total: 1 }, error: null })
    );
    jest.doMock('../../../../config/supabase', () => ({ supabase: mockSupabase }));
    const { importGraphDataset } = require('../graphImport.service');

    const result = await importGraphDataset({
      buffer: Buffer.from('unused'),
      datasetType: 'roles',
      adminId: 'admin-1',
      mode: 'replace',
    });

    expect(result.imported).toBe(1);
    expect(mockSupabase.rpc).toHaveBeenCalledWith('replace_import_roles', expect.any(Object));
    expect(mockSupabase.upsertSpies.roles).toBeUndefined();
  });

  it('skills Append — onConflict: skill_id', async () => {
    const { parseCSVBuffer } = require('../../import/csvParser.util');
    parseCSVBuffer.mockReturnValue([
      { skill_id: 's1', skill_name: 'JavaScript', old_id: 'legacy-1' },
    ]);

    const mockSupabase = createSupabaseMock({});
    jest.doMock('../../../../config/supabase', () => ({ supabase: mockSupabase }));
    const { importGraphDataset } = require('../graphImport.service');

    const result = await importGraphDataset({
      buffer: Buffer.from('unused'),
      datasetType: 'skills',
      adminId: 'admin-1',
      mode: 'append',
    });

    expect(result.imported).toBe(1);
    expect(mockSupabase.upsertSpies.skills).toHaveBeenCalledWith(
      expect.any(Array),
      { onConflict: 'skill_id' }
    );
  });

  it('role_skills Append — onConflict: role_id,skill_id', async () => {
    const { parseCSVBuffer } = require('../../import/csvParser.util');
    parseCSVBuffer.mockReturnValue([{ role_id: 'r1', skill_id: 's1' }]);

    const mockSupabase = createSupabaseMock({
      roles: { data: [{ role_id: 'r1' }], error: null },
      career_skills_registry: { data: [{ skill_id: 's1' }], error: null },
    });
    jest.doMock('../../../../config/supabase', () => ({ supabase: mockSupabase }));
    const { importGraphDataset } = require('../graphImport.service');

    const result = await importGraphDataset({
      buffer: Buffer.from('unused'),
      datasetType: 'role_skills',
      adminId: 'admin-1',
      mode: 'append',
    });

    expect(result.imported).toBe(1);
    expect(mockSupabase.upsertSpies.role_skills).toHaveBeenCalledWith(
      expect.any(Array),
      { onConflict: 'role_id,skill_id' }
    );
  });

  it('role_transitions Append — onConflict: from_role_id,to_role_id', async () => {
    const { parseCSVBuffer } = require('../../import/csvParser.util');
    parseCSVBuffer.mockReturnValue([{ from_role_id: 'r1', to_role_id: 'r2' }]);

    const mockSupabase = createSupabaseMock({
      roles: { data: [{ role_id: 'r1' }, { role_id: 'r2' }], error: null },
    });
    jest.doMock('../../../../config/supabase', () => ({ supabase: mockSupabase }));
    const { importGraphDataset } = require('../graphImport.service');

    const result = await importGraphDataset({
      buffer: Buffer.from('unused'),
      datasetType: 'role_transitions',
      adminId: 'admin-1',
      mode: 'append',
    });

    expect(result.imported).toBe(1);
    expect(mockSupabase.upsertSpies.role_transitions).toHaveBeenCalledWith(
      expect.any(Array),
      { onConflict: 'from_role_id,to_role_id' }
    );
  });

  it('skill_relationships Append — onConflict: skill_id,related_skill_id', async () => {
    const { parseCSVBuffer } = require('../../import/csvParser.util');
    parseCSVBuffer.mockReturnValue([
      { skill_id: 's1', related_skill_id: 's2', relationship_type: 'related' },
    ]);

    const mockSupabase = createSupabaseMock({
      career_skills_registry: { data: [{ skill_id: 's1' }, { skill_id: 's2' }], error: null },
    });
    jest.doMock('../../../../config/supabase', () => ({ supabase: mockSupabase }));
    const { importGraphDataset } = require('../graphImport.service');

    const result = await importGraphDataset({
      buffer: Buffer.from('unused'),
      datasetType: 'skill_relationships',
      adminId: 'admin-1',
      mode: 'append',
    });

    expect(result.imported).toBe(1);
    expect(mockSupabase.upsertSpies.skill_relationships).toHaveBeenCalledWith(
      expect.any(Array),
      { onConflict: 'skill_id,related_skill_id' }
    );
  });

  it('role_education Append — onConflict: role_id,education_level', async () => {
    const { parseCSVBuffer } = require('../../import/csvParser.util');
    parseCSVBuffer.mockReturnValue([{ role_id: 'r1', education_level: 'bachelor' }]);

    const mockSupabase = createSupabaseMock({
      roles: { data: [{ role_id: 'r1' }], error: null },
    });
    jest.doMock('../../../../config/supabase', () => ({ supabase: mockSupabase }));
    const { importGraphDataset } = require('../graphImport.service');

    const result = await importGraphDataset({
      buffer: Buffer.from('unused'),
      datasetType: 'role_education',
      adminId: 'admin-1',
      mode: 'append',
    });

    expect(result.imported).toBe(1);
    expect(mockSupabase.upsertSpies.role_education).toHaveBeenCalledWith(
      expect.any(Array),
      { onConflict: 'role_id,education_level' }
    );
  });

  it('role_salary_market Append — onConflict: role_id,country', async () => {
    const { parseCSVBuffer } = require('../../import/csvParser.util');
    parseCSVBuffer.mockReturnValue([{ role_id: 'r1', country: 'IN' }]);

    const mockSupabase = createSupabaseMock({
      roles: { data: [{ role_id: 'r1' }], error: null },
    });
    jest.doMock('../../../../config/supabase', () => ({ supabase: mockSupabase }));
    const { importGraphDataset } = require('../graphImport.service');

    const result = await importGraphDataset({
      buffer: Buffer.from('unused'),
      datasetType: 'role_salary_market',
      adminId: 'admin-1',
      mode: 'append',
    });

    expect(result.imported).toBe(1);
    expect(mockSupabase.upsertSpies.role_salary_market).toHaveBeenCalledWith(
      expect.any(Array),
      { onConflict: 'role_id,country' }
    );
  });

  it('role_market_demand Append — onConflict: role_id,country', async () => {
    const { parseCSVBuffer } = require('../../import/csvParser.util');
    parseCSVBuffer.mockReturnValue([{ role_id: 'r1', country: 'IN' }]);

    const mockSupabase = createSupabaseMock({
      roles: { data: [{ role_id: 'r1' }], error: null },
    });
    jest.doMock('../../../../config/supabase', () => ({ supabase: mockSupabase }));
    const { importGraphDataset } = require('../graphImport.service');

    const result = await importGraphDataset({
      buffer: Buffer.from('unused'),
      datasetType: 'role_market_demand',
      adminId: 'admin-1',
      mode: 'append',
    });

    expect(result.imported).toBe(1);
    expect(mockSupabase.upsertSpies.role_market_demand).toHaveBeenCalledWith(
      expect.any(Array),
      { onConflict: 'role_id,country' }
    );
  });
});
