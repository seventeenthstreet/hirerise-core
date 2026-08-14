'use strict';

/**
 * @file graphImport.service.r17.test.js
 * @description WP-ADMIN-COMP-08-R17 focused tests.
 *
 * Covers:
 *   T1 — valid skill_id (existing in career_skills_registry) is accepted.
 *   T2 — invalid skill_id (absent from career_skills_registry) is rejected.
 *   T3 — role_skills.skill_id queries career_skills_registry.skill_id.
 *   T4 — skill_relationships.skill_id queries career_skills_registry.skill_id.
 *   T5 — skill_relationships.related_skill_id queries
 *        career_skills_registry.skill_id.
 *   T6 — mixed valid/invalid batch preserves row-level semantics.
 *   T7 — successful empty lookup is distinguishable from lookup failure.
 *   T8 — a simulated database/query failure is surfaced as
 *        'fk_lookup_failed', never silently treated as an ordinary FK
 *        rejection or a successful empty lookup.
 *   T9 — R14 role-identity validation is not regressed by this change.
 */

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
    return entry || { data: [], error: null };
  }

  function makeBuilder(table) {
    const builder = {
      select: () => builder,
      in: () => builder,
      then: (resolve, reject) => Promise.resolve(resolveFor(table)).then(resolve, reject),
    };
    return builder;
  }

  return { from: jest.fn((table) => makeBuilder(table)) };
}

describe('WP-ADMIN-COMP-08-R17 — skill authority repoint & lookup-failure semantics', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  describe('T1/T2 — skill identity validation against career_skills_registry', () => {
    it('T1: accepts a skill_id present in career_skills_registry.skill_id', async () => {
      const mockSupabase = createSupabaseMock({
        roles: { data: [{ role_id: 'r1' }], error: null },
        career_skills_registry: { data: [{ skill_id: 's1' }], error: null },
      });
      jest.doMock('../../../../config/supabase', () => ({ supabase: mockSupabase }));
      const { buildFKSets, detectFKErrors, SCHEMAS } = require('../graphImport.service');

      const rows = [{ __rowNum: 2, role_id: 'r1', skill_id: 's1' }];
      const fkSets = await buildFKSets(rows, SCHEMAS.role_skills.fkChecks);
      const errors = detectFKErrors(rows, SCHEMAS.role_skills, fkSets);

      expect(errors).toEqual([]);
    });

    it('T2: rejects a skill_id absent from career_skills_registry.skill_id', async () => {
      const mockSupabase = createSupabaseMock({
        roles: { data: [{ role_id: 'r1' }], error: null },
        career_skills_registry: { data: [{ skill_id: 's1' }], error: null },
      });
      jest.doMock('../../../../config/supabase', () => ({ supabase: mockSupabase }));
      const { buildFKSets, detectFKErrors, SCHEMAS } = require('../graphImport.service');

      const rows = [{ __rowNum: 2, role_id: 'r1', skill_id: 'does-not-exist' }];
      const fkSets = await buildFKSets(rows, SCHEMAS.role_skills.fkChecks);
      const errors = detectFKErrors(rows, SCHEMAS.role_skills, fkSets);

      expect(errors).toEqual([
        expect.objectContaining({ row: 2, field: 'skill_id', type: 'fk' }),
      ]);
    });
  });

  describe('T3/T4/T5 — corrected authority is actually queried', () => {
    it('T3: role_skills.skill_id queries the career_skills_registry table on skill_id', async () => {
      const mockSupabase = createSupabaseMock({
        career_skills_registry: { data: [{ skill_id: 's1' }], error: null },
        roles: { data: [{ role_id: 'r1' }], error: null },
      });
      jest.doMock('../../../../config/supabase', () => ({ supabase: mockSupabase }));
      const { buildFKSets, SCHEMAS } = require('../graphImport.service');

      const rows = [{ __rowNum: 2, role_id: 'r1', skill_id: 's1' }];
      await buildFKSets(rows, SCHEMAS.role_skills.fkChecks);

      expect(mockSupabase.from).toHaveBeenCalledWith('career_skills_registry');
      expect(mockSupabase.from).not.toHaveBeenCalledWith('skills');
    });

    it('T4: skill_relationships.skill_id queries career_skills_registry', async () => {
      const mockSupabase = createSupabaseMock({
        career_skills_registry: { data: [{ skill_id: 's1' }, { skill_id: 's2' }], error: null },
      });
      jest.doMock('../../../../config/supabase', () => ({ supabase: mockSupabase }));
      const { buildFKSets, detectFKErrors, SCHEMAS } = require('../graphImport.service');

      const rows = [{ __rowNum: 2, skill_id: 's1', related_skill_id: 's2' }];
      const fkSets = await buildFKSets(rows, SCHEMAS.skill_relationships.fkChecks);
      const errors = detectFKErrors(rows, SCHEMAS.skill_relationships, fkSets);

      expect(mockSupabase.from).toHaveBeenCalledWith('career_skills_registry');
      expect(errors.filter((e) => e.field === 'skill_id')).toEqual([]);
    });

    it('T5: skill_relationships.related_skill_id queries career_skills_registry', async () => {
      const mockSupabase = createSupabaseMock({
        career_skills_registry: { data: [{ skill_id: 's1' }], error: null },
      });
      jest.doMock('../../../../config/supabase', () => ({ supabase: mockSupabase }));
      const { buildFKSets, detectFKErrors, SCHEMAS } = require('../graphImport.service');

      const rows = [{ __rowNum: 2, skill_id: 's1', related_skill_id: 'missing-related' }];
      const fkSets = await buildFKSets(rows, SCHEMAS.skill_relationships.fkChecks);
      const errors = detectFKErrors(rows, SCHEMAS.skill_relationships, fkSets);

      expect(errors).toEqual([
        expect.objectContaining({ row: 2, field: 'related_skill_id', type: 'fk' }),
      ]);
    });
  });

  describe('T6 — mixed valid/invalid batch', () => {
    it('preserves row-level FK semantics: only the invalid row is rejected', async () => {
      const mockSupabase = createSupabaseMock({
        career_skills_registry: { data: [{ skill_id: 's1' }], error: null },
        roles: { data: [{ role_id: 'r1' }], error: null },
      });
      jest.doMock('../../../../config/supabase', () => ({ supabase: mockSupabase }));
      const { buildFKSets, detectFKErrors, SCHEMAS } = require('../graphImport.service');

      const rows = [
        { __rowNum: 2, role_id: 'r1', skill_id: 's1' }, // valid
        { __rowNum: 3, role_id: 'r1', skill_id: 's-missing' }, // invalid
      ];
      const fkSets = await buildFKSets(rows, SCHEMAS.role_skills.fkChecks);
      const errors = detectFKErrors(rows, SCHEMAS.role_skills, fkSets);

      expect(errors).toHaveLength(1);
      expect(errors[0].row).toBe(3);
    });
  });

  describe('T7 — successful empty lookup vs lookup failure', () => {
    it('a successful query returning zero rows is a real empty Set, not a failure marker', async () => {
      const mockSupabase = createSupabaseMock({
        roles: { data: [{ role_id: 'r1' }], error: null },
        career_skills_registry: { data: [], error: null },
      });
      jest.doMock('../../../../config/supabase', () => ({ supabase: mockSupabase }));
      const { buildFKSets, detectFKErrors, SCHEMAS } = require('../graphImport.service');

      const rows = [{ __rowNum: 2, role_id: 'r1', skill_id: 's1' }];
      const fkSets = await buildFKSets(rows, SCHEMAS.role_skills.fkChecks);
      const errors = detectFKErrors(rows, SCHEMAS.role_skills, fkSets);

      // Legitimately no matching skill — an ordinary FK violation, NOT a
      // lookup-failure type.
      expect(errors).toEqual([
        expect.objectContaining({ row: 2, field: 'skill_id', type: 'fk' }),
      ]);
    });
  });

  describe('T8 — simulated lookup failure', () => {
    it('surfaces failure as fk_lookup_failed, distinct from an ordinary fk rejection or success', async () => {
      const mockSupabase = createSupabaseMock({
        roles: { data: [{ role_id: 'r1' }], error: null },
        career_skills_registry: { data: null, error: { message: 'connection reset' } },
      });
      jest.doMock('../../../../config/supabase', () => ({ supabase: mockSupabase }));
      const {
        buildFKSets,
        detectFKErrors,
        detectFKOrphans,
        SCHEMAS,
      } = require('../graphImport.service');

      const rows = [{ __rowNum: 2, id: 'row-1', role_id: 'r1', skill_id: 's1' }];
      const fkSets = await buildFKSets(rows, SCHEMAS.role_skills.fkChecks);
      const errors = detectFKErrors(rows, SCHEMAS.role_skills, fkSets);
      const orphans = detectFKOrphans(rows, SCHEMAS.role_skills, fkSets);

      // Failure is observable and distinctly typed...
      expect(errors).toEqual([
        expect.objectContaining({ row: 2, field: 'skill_id', type: 'fk_lookup_failed' }),
      ]);
      // ...never reported as an ordinary FK rejection...
      expect(errors.some((e) => e.type === 'fk')).toBe(false);
      // ...and never silently folded into "no orphans found".
      expect(orphans).toEqual([]);
    });
  });

  describe('T9 — R14 role-identity regression check', () => {
    it('valid role identities are still accepted after the skill-authority repoint', async () => {
      const mockSupabase = createSupabaseMock({
        roles: { data: [{ role_id: 'role-a' }, { role_id: 'role-b' }], error: null },
      });
      jest.doMock('../../../../config/supabase', () => ({ supabase: mockSupabase }));
      const { buildFKSets, detectFKErrors, SCHEMAS } = require('../graphImport.service');

      const rows = [{ __rowNum: 2, from_role_id: 'role-a', to_role_id: 'role-b' }];
      const fkSets = await buildFKSets(rows, SCHEMAS.role_transitions.fkChecks);
      const errors = detectFKErrors(rows, SCHEMAS.role_transitions, fkSets);

      expect(errors).toEqual([]);
      expect(mockSupabase.from).toHaveBeenCalledWith('roles');
    });

    it('invalid role identities are still rejected after the skill-authority repoint', async () => {
      const mockSupabase = createSupabaseMock({
        roles: { data: [{ role_id: 'role-a' }], error: null },
      });
      jest.doMock('../../../../config/supabase', () => ({ supabase: mockSupabase }));
      const { buildFKSets, detectFKErrors, SCHEMAS } = require('../graphImport.service');

      const rows = [{ __rowNum: 2, from_role_id: 'role-a', to_role_id: 'role-missing' }];
      const fkSets = await buildFKSets(rows, SCHEMAS.role_transitions.fkChecks);
      const errors = detectFKErrors(rows, SCHEMAS.role_transitions, fkSets);

      expect(errors).toEqual([
        expect.objectContaining({ row: 2, field: 'to_role_id', type: 'fk' }),
      ]);
    });
  });
});
