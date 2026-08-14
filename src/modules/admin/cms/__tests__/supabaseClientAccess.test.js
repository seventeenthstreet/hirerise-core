'use strict';

/**
 * @file supabaseClientAccess.test.js
 * @description
 * WP-ADMIN-COMP-02 — Supabase client access defect regression coverage
 * for the CMS Admin backend.
 *
 * adminCmsGeneric.factory.js previously did
 * `getSupabase() { return require('.../config/supabase'); }`, returning
 * the config module instead of the client. Because Job Families,
 * Education Levels, and Salary Benchmarks are all pre-built instances of
 * this factory (consumed directly by server.js), the defect broke list/
 * create/update/delete for all three CMS datasets in one place.
 */

function mockSupabaseModule() {
  const row = { id: 'r1', name: 'Engineering', normalized_name: 'engineering', soft_deleted: false };
  const builder = {
    select: jest.fn(() => builder),
    eq: jest.fn(() => builder),
    order: jest.fn(() => builder),
    range: jest.fn(() => Promise.resolve({ data: [row], error: null, count: 1 })),
    maybeSingle: jest.fn(() => Promise.resolve({ data: row, error: null })),
    single: jest.fn(() => Promise.resolve({ data: row, error: null })),
    insert: jest.fn(() => builder),
    update: jest.fn(() => builder),
  };
  const from = jest.fn(() => builder);
  const client = { from };

  return {
    supabase: client,
    getClient: jest.fn(() => client),
    withRetry: jest.fn((fn) => fn()),
    verifyConnection: jest.fn(),
    __client: client,
  };
}

describe('CMS admin backend — Supabase client access (WP-ADMIN-COMP-02)', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('adminCmsGeneric.factory.js: Job Families / Education Levels / Salary Benchmarks all resolve the real client', async () => {
    const mocked = mockSupabaseModule();
    jest.doMock('../../../../config/supabase', () => mocked);

    const {
      jobFamiliesModule,
      educationLevelsModule,
      salaryBenchmarksModule,
    } = require('../adminCmsGeneric.factory');

    await jobFamiliesModule.repository.list({});
    await educationLevelsModule.repository.list({});
    await salaryBenchmarksModule.repository.list({});

    expect(mocked.__client.from).toHaveBeenCalledWith('cms_job_families');
    expect(mocked.__client.from).toHaveBeenCalledWith('cms_education_levels');
    expect(mocked.__client.from).toHaveBeenCalledWith('cms_salary_benchmarks');
  });

  test('adminCmsGeneric.factory.js: Skill Clusters (built on the same factory) resolves the real client', async () => {
    const mocked = mockSupabaseModule();
    jest.doMock('../../../../config/supabase', () => mocked);

    const skillClustersModule = require('../skill-clusters/adminCmsSkillClusters.module');
    await skillClustersModule.repository.list({});

    expect(mocked.__client.from).toHaveBeenCalledWith('cms_skill_clusters');
  });
});
