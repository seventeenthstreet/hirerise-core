'use strict';

/**
 * @file job.repository.test.js
 * @description WP-ADMIN-COMP-06 regression tests.
 *
 * Covers:
 *   1. getSupabase() bugfix — repository methods reach the actual Supabase
 *      client (no "supabase.from is not a function").
 *   2. bulkUpsert writes to the real "jobs" table columns, not the
 *      nonexistent job_code/currency/source_type/source_url/is_deleted/
 *      updated_at columns the previous mapping used.
 *   3. bulkUpsert's onConflict target is "external_id,source", matching
 *      the real unique index jobs_external_source_uq.
 *   4. list() and findById() — new Admin Job List/Detail read methods.
 */

let mock;

jest.mock('../../../../../config/supabase', () => ({
  get supabase() {
    return mock;
  },
}));

jest.mock('../../../../../utils/logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
}));

/**
 * Minimal chainable fake covering exactly the query shapes job.repository.js
 * issues:
 *   .from(T).upsert(rows, opts).select(cols)                (awaited directly)
 *   .from(T).select('*').eq(...).eq(...).maybeSingle()
 *   .from(T).select('*', { count }).order().range().eq().or()  (awaited directly)
 *   .from(T).select('*').eq('id', ...).maybeSingle()
 */
function createSupabaseMock({ upsertResult, selectRows = [], selectCount = 0 } = {}) {
  const calls = { upsert: [], eq: [], or: [] };

  function from(table) {
    let terminal = null; // { type: 'upsert' } | { type: 'select' }
    let single = false;

    const builder = {
      upsert(rows, opts) {
        calls.upsert.push({ table, rows, opts });
        terminal = { type: 'upsert' };
        return builder;
      },
      select(cols, opts) {
        if (!terminal) terminal = { type: 'select', opts };
        return builder;
      },
      eq(col, val) {
        calls.eq.push([col, val]);
        return builder;
      },
      or(expr) {
        calls.or.push(expr);
        return builder;
      },
      order() {
        return builder;
      },
      range() {
        return builder;
      },
      maybeSingle() {
        single = true;
        return Promise.resolve(
          terminal?.type === 'upsert'
            ? upsertResult ?? { data: [], error: null }
            : { data: selectRows[0] ?? null, error: null }
        );
      },
      then(resolve, reject) {
        const result =
          terminal?.type === 'upsert'
            ? upsertResult ?? { data: (calls.upsert.at(-1)?.rows || []).map((r) => ({ external_id: r.external_id })), error: null }
            : { data: selectRows, error: null, count: selectCount };
        return Promise.resolve(result).then(resolve, reject);
      },
    };

    return builder;
  }

  return { from, __calls: calls };
}

describe('job.repository', () => {
  let repo;

  beforeEach(() => {
    jest.resetModules();
    repo = require('../job.repository');
  });

  describe('getSupabase() bugfix', () => {
    it('reaches the Supabase client for list() (no "supabase.from is not a function")', async () => {
      mock = createSupabaseMock({ selectRows: [], selectCount: 0 });
      await expect(repo.list()).resolves.toEqual({ items: [], total: 0 });
    });

    it('reaches the Supabase client for bulkUpsert() (no "supabase.from is not a function")', async () => {
      mock = createSupabaseMock();
      await expect(
        repo.bulkUpsert([{ jobCode: 'ABC-1', title: 'Engineer', company: 'Acme', location: 'Remote', type: 'full_time' }], { source: 'csv' })
      ).resolves.toEqual(1);
    });
  });

  describe('bulkUpsert — real column mapping', () => {
    it('maps to actual "jobs" table columns, not job_code/currency/source_type/source_url/is_deleted/updated_at', async () => {
      mock = createSupabaseMock();

      await repo.bulkUpsert(
        [
          {
            jobCode: 'eng-42',
            title: 'Backend Engineer',
            company: 'Acme Corp',
            location: 'Bangalore',
            type: 'full_time',
            salary: { min: 800000, max: 1200000, currency: 'INR' },
            description: 'Build things',
            tags: ['node', 'postgres'],
            externalUrl: 'https://example.com/jobs/42',
            postedAt: '2026-08-01T00:00:00.000Z',
          },
        ],
        { source: 'json' }
      );

      const [{ rows, opts }] = mock.__calls.upsert;
      const row = rows[0];

      expect(row).toMatchObject({
        external_id: 'ENG-42',
        title: 'Backend Engineer',
        company: 'Acme Corp',
        location: 'Bangalore',
        contract_type: 'full_time',
        salary_min: 800000,
        salary_max: 1200000,
        salary_currency: 'INR',
        description: 'Build things',
        skills: ['node', 'postgres'],
        redirect_url: 'https://example.com/jobs/42',
        posted_at: '2026-08-01T00:00:00.000Z',
        source: 'json',
      });

      // None of the old, nonexistent columns should be present.
      expect(row).not.toHaveProperty('job_code');
      expect(row).not.toHaveProperty('currency');
      expect(row).not.toHaveProperty('source_type');
      expect(row).not.toHaveProperty('source_url');
      expect(row).not.toHaveProperty('is_deleted');
      expect(row).not.toHaveProperty('updated_at');

      expect(opts.onConflict).toBe('external_id,source');
    });

    it('defaults source to "admin_sync" when no sourceType is passed through', async () => {
      mock = createSupabaseMock();
      await repo.bulkUpsert([{ jobCode: 'X-1', title: 'T', company: 'C', location: 'L', type: 'full_time' }]);
      const [{ rows }] = mock.__calls.upsert;
      expect(rows[0].source).toBe('admin_sync');
    });
  });

  describe('list()', () => {
    it('returns items and an authoritative total from Supabase count', async () => {
      mock = createSupabaseMock({
        selectRows: [{ id: '1', title: 'A' }, { id: '2', title: 'B' }],
        selectCount: 37,
      });

      const result = await repo.list({ limit: 2, offset: 0 });

      expect(result).toEqual({
        items: [{ id: '1', title: 'A' }, { id: '2', title: 'B' }],
        total: 37,
      });
    });

    it('applies a search filter across title/company/location via ilike', async () => {
      mock = createSupabaseMock({ selectRows: [], selectCount: 0 });
      await repo.list({ search: 'engineer' });
      expect(mock.__calls.or[0]).toContain('title.ilike.%engineer%');
      expect(mock.__calls.or[0]).toContain('company.ilike.%engineer%');
      expect(mock.__calls.or[0]).toContain('location.ilike.%engineer%');
    });

    it('applies a source filter', async () => {
      mock = createSupabaseMock({ selectRows: [], selectCount: 0 });
      await repo.list({ source: 'json' });
      expect(mock.__calls.eq).toContainEqual(['source', 'json']);
    });
  });

  describe('findById()', () => {
    it('returns the job when found', async () => {
      mock = createSupabaseMock({ selectRows: [{ id: 'job-1', title: 'Engineer' }] });
      await expect(repo.findById('job-1')).resolves.toEqual({ id: 'job-1', title: 'Engineer' });
    });

    it('returns null when not found', async () => {
      mock = createSupabaseMock({ selectRows: [] });
      await expect(repo.findById('missing')).resolves.toBeNull();
    });
  });
});
