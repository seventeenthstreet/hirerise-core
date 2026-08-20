'use strict';

/**
 * @file graphIntelligence.searchRoles.regression.test.js
 * @description Regression coverage for the WP-ADMIN-COMP-11 Career Graph
 * role-search defect.
 *
 * `roles` (see supabase/migrations/000_initial_schema.sql) has a
 * `role_name` column and NO `name` column. `searchRoles` in
 * graphIntelligence.controller.js previously did:
 *
 *   .select('role_id, role_name, name')
 *   .or(`role_name.ilike.%${q}%,name.ilike.%${q}%`)
 *
 * which Postgres/PostgREST rejects with `42703: column roles.name does not
 * exist` on every search with a non-empty `q`. The frontend then rendered
 * that 500 as an ordinary "No roles found." result (a separate,
 * also-fixed defect — see RolePicker.test.tsx), making the failure
 * invisible in the UI.
 *
 * This test proves, against the corrected code, that the query touches
 * only real columns and never references `roles.name` in any form.
 */

function makeRealShapedSupabaseModule(fromImpl) {
  const client = { from: jest.fn(fromImpl) };
  return {
    wrapperModule: {
      supabase: client,
      getClient: jest.fn(() => client),
      withRetry: jest.fn((fn) => fn()),
      verifyConnection: jest.fn().mockResolvedValue(true),
    },
    client,
  };
}

/**
 * Chainable builder that records every `select`/`ilike`/`or`/`limit` call
 * it receives, so the test can assert on the exact arguments used —
 * proving the query shape, not just that *some* query ran.
 */
function chainableSearchBuilder(result, calls) {
  const builder = {
    select: (...args) => {
      calls.select.push(args);
      return builder;
    },
    limit: (...args) => {
      calls.limit.push(args);
      return builder;
    },
    ilike: (...args) => {
      calls.ilike.push(args);
      return builder;
    },
    or: (...args) => {
      calls.or.push(args);
      return builder;
    },
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return builder;
}

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

// See graphSupabaseClientAccess.regression.test.js for why this wrapper is
// necessary: asyncHandler does not return its promise to the caller, so a
// plain `await handler(...)` resolves before the handler's own async work
// (and therefore its Supabase calls) has actually run.
function invokeAsyncHandler(handler, req, res) {
  return new Promise((resolve, reject) => {
    const originalJson = res.json.bind(res);
    res.json = (payload) => {
      originalJson(payload);
      resolve();
      return res;
    };
    handler(req, res, (err) => {
      if (err) reject(err);
    });
  });
}

jest.mock('../../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

describe('graphIntelligence.controller.js — searchRoles column regression (WP-ADMIN-COMP-11)', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  it('selects only real roles columns (role_id, role_name) — never a fictitious "name" column', async () => {
    const calls = { select: [], limit: [], ilike: [], or: [] };
    const { wrapperModule, client } = makeRealShapedSupabaseModule(() =>
      chainableSearchBuilder({ data: [{ role_id: 'r1', role_name: 'Product Manager' }], error: null }, calls),
    );
    jest.doMock('../../../../config/supabase', () => wrapperModule);

    const { searchRoles } = require('../graphIntelligence.controller');

    const req = { query: { q: 'Product Manager', limit: '20' } };
    const res = makeRes();

    await invokeAsyncHandler(searchRoles, req, res);

    expect(client.from).toHaveBeenCalledWith('roles');

    // Proof #1: the select list contains only real columns.
    expect(calls.select).toHaveLength(1);
    const selectArg = calls.select[0][0];
    expect(selectArg).not.toMatch(/(^|[,\s])name(\s|,|$)/);
    expect(selectArg).toMatch(/role_id/);
    expect(selectArg).toMatch(/role_name/);

    // Proof #2: filtering happens on the real role_name column — never on
    // a `roles.name` reference, whether via `.or()` or otherwise.
    expect(calls.or).toHaveLength(0);
    expect(calls.ilike).toHaveLength(1);
    const [ilikeColumn, ilikeValue] = calls.ilike[0];
    expect(ilikeColumn).toBe('role_name');
    expect(ilikeValue).toBe('%Product Manager%');

    // Proof #3: the response shape matches the actual (corrected) contract
    // — no fictitious `name` field is fabricated anywhere downstream.
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual([{ role_id: 'r1', role_name: 'Product Manager' }]);
    expect(res.body.data[0]).not.toHaveProperty('name');
  });

  it('does not filter at all for an empty query, but still selects only real columns', async () => {
    const calls = { select: [], limit: [], ilike: [], or: [] };
    const { wrapperModule } = makeRealShapedSupabaseModule(() =>
      chainableSearchBuilder({ data: [], error: null }, calls),
    );
    jest.doMock('../../../../config/supabase', () => wrapperModule);

    const { searchRoles } = require('../graphIntelligence.controller');

    const req = { query: {} };
    const res = makeRes();

    await invokeAsyncHandler(searchRoles, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(calls.ilike).toHaveLength(0);
    expect(calls.or).toHaveLength(0);
    expect(calls.select[0][0]).not.toMatch(/(^|[,\s])name(\s|,|$)/);
  });
});
