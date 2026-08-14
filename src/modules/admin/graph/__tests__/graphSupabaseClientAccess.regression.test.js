'use strict';

/**
 * @file graphSupabaseClientAccess.regression.test.js
 * @description WP-ADMIN-COMP-08-R1 regression coverage.
 *
 * `core/src/config/supabase.js` exports a WRAPPER object:
 *
 *   module.exports = { supabase, getClient, withRetry, verifyConnection };
 *
 * Three Graph files previously treated the raw `require(...)` result as if
 * it WERE the Supabase client, instead of reading its `.supabase` property:
 *
 *   - graphImport.service.js       — `getSupabase = () => require(...)`
 *   - graphAdmin.controller.js     — `const supabase = require(...)`
 *   - graphIntelligence.controller.js — `getClient() { return require(...); }`
 *
 * Every call site then did `supabase.from(...)`, which throws
 * `TypeError: supabase.from is not a function` because `.from` only exists
 * on the wrapper's `.supabase` property, not on the wrapper itself.
 *
 * Each test below mocks `config/supabase` with its REAL two-level shape
 * (`{ supabase: <client with .from>, getClient, withRetry,
 * verifyConnection }`) and asserts that the *inner* client's `.from` mock
 * is actually invoked.
 *
 * Written against the pre-fix code (`require('../../../config/supabase')`
 * used directly, no `.supabase` accessor), every test in this file fails:
 * either with an uncaught `TypeError: ... .from is not a function`, or —
 * for the controller's `warmGraphCache`, which swallows that error — with
 * `client.from` never having been called at all. Against the corrected
 * code, all three pass.
 */

jest.mock('../../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../../../../config/redisClient', () => ({
  redis: { del: jest.fn().mockResolvedValue(1) },
}));

jest.mock('../../../../utils/cache.util', () => ({
  setCache: jest.fn().mockResolvedValue(undefined),
  getCache: jest.fn().mockResolvedValue(null),
}));

jest.mock('../../import/csvParser.util', () => ({
  parseCSVBuffer: jest.fn(),
}));

/**
 * Builds the REAL shape of `require('config/supabase')`: a wrapper object
 * whose `.supabase` property is the actual chainable query client. This is
 * deliberately NOT the client itself — a test mocking `config/supabase` to
 * return the client directly would pass under both the old buggy code and
 * the fix, and would prove nothing.
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

function chainableBuilder(result = { data: [], error: null }) {
  const builder = {
    select: () => builder,
    in: () => builder,
    order: () => builder,
    limit: () => builder,
    eq: () => builder,
    maybeSingle: () => Promise.resolve(result),
    upsert: jest.fn(() => Promise.resolve(result)),
    insert: jest.fn(() => Promise.resolve(result)),
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

/**
 * asyncHandler (utils/helpers.js) wraps handlers as
 * `Promise.resolve().then(() => fn(req, res, next)).catch(next)` and does
 * NOT return that promise to the caller — so `await handler(req, res,
 * next)` resolves immediately, before the handler's own async work (and
 * therefore its Supabase calls) has actually run. This helper awaits real
 * completion by resolving/rejecting once `res.json` is called or `next`
 * receives an error, matching how Express itself drives the handler.
 */
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

describe('Graph Supabase client access — module-shape regression (WP-ADMIN-COMP-08-R1)', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  describe('graphImport.service.js', () => {
    it('getGraphMetrics() reads the client from require(config/supabase).supabase, not the wrapper', async () => {
      const { wrapperModule, client } = makeRealShapedSupabaseModule(() =>
        chainableBuilder({
          data: {
            total_roles: 1,
            total_skills: 1,
            total_role_transitions: 0,
            total_skill_relationships: 0,
            total_role_skills: 0,
          },
          error: null,
        }),
      );
      jest.doMock('../../../../config/supabase', () => wrapperModule);

      const { getGraphMetrics } = require('../graphImport.service');
      const result = await getGraphMetrics();

      // The proof: the INNER client's own `.from` mock was actually
      // invoked. Under the old bug, `getSupabase()` returns `wrapperModule`
      // itself (no `.from` on it at all) and this assertion is unreachable
      // — the call throws before returning.
      expect(client.from).toHaveBeenCalledWith('graph_metrics');
      expect(result.total_roles).toBe(1);
    });

    it('importGraphDataset() (actual write path) reaches the inner client, not the wrapper', async () => {
      const { parseCSVBuffer } = require('../../import/csvParser.util');
      parseCSVBuffer.mockReturnValue([{ role_id: 'r1', role_name: 'Engineer' }]);

      const { wrapperModule, client } = makeRealShapedSupabaseModule(() =>
        chainableBuilder({ data: [], error: null }),
      );
      jest.doMock('../../../../config/supabase', () => wrapperModule);

      const { importGraphDataset } = require('../graphImport.service');

      await importGraphDataset({
        buffer: Buffer.from('unused — parseCSVBuffer is mocked'),
        datasetType: 'roles',
        adminId: 'admin-1',
        preview: false,
        mode: 'append',
      });

      expect(client.from).toHaveBeenCalledWith('roles');
    });
  });

  describe('graphAdmin.controller.js', () => {
    it('the module-level `supabase` binding resolves to the real client (warmGraphCache reaches supabase.from)', async () => {
      const { parseCSVBuffer } = require('../../import/csvParser.util');
      parseCSVBuffer.mockReturnValue([{ role_id: 'r1', role_name: 'Engineer' }]);

      const { wrapperModule, client } = makeRealShapedSupabaseModule((table) =>
        chainableBuilder(
          table === 'roles'
            ? { data: [{ role_id: 'r1', role_name: 'Engineer' }], error: null }
            : { data: [], error: null },
        ),
      );
      jest.doMock('../../../../config/supabase', () => wrapperModule);

      // graphAdmin.controller.js requires graphImport.service.js internally
      // at load time; under the same jest.doMock both files' Supabase
      // access resolves against this one mocked wrapper.
      const ctrl = require('../graphAdmin.controller');

      const req = {
        params: { datasetType: 'roles' },
        body: { mode: 'append' },
        file: {
          buffer: Buffer.from('unused'),
          size: 10,
          originalname: 'roles.csv',
          mimetype: 'text/csv',
        },
        user: { id: 'admin-1' },
      };
      const res = makeRes();

      await invokeAsyncHandler(ctrl.importDataset, req, res);

      expect(res.statusCode).toBe(200);

      // warmGraphCache runs after a successful `roles` import and calls
      // `supabase.from('roles')` / `.from('role_transitions')` directly on
      // the controller's module-level `supabase` binding. Under the old
      // bug that binding has no `.from` method at all, so warmGraphCache's
      // internal try/catch silently swallows the TypeError and this mock
      // is never reached — this assertion is what catches that silent
      // failure.
      expect(client.from).toHaveBeenCalledWith('roles');
    });
  });

  describe('graphIntelligence.controller.js', () => {
    it('getClient() returns the inner client (with .from), not the wrapper module', async () => {
      const { wrapperModule, client } = makeRealShapedSupabaseModule((table) =>
        chainableBuilder(
          table === 'roles'
            ? { data: [{ role_id: 'r1', role_name: 'Engineer' }], error: null }
            : { data: [{ from_role_id: 'r1', to_role_id: 'r2' }], error: null },
        ),
      );
      jest.doMock('../../../../config/supabase', () => wrapperModule);

      const { getCareerGraph } = require('../graphIntelligence.controller');

      const req = {};
      const res = makeRes();

      await invokeAsyncHandler(getCareerGraph, req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);

      // Proof: getClient()'s return value is the object whose `.from` was
      // actually called. Under the old bug, getClient() returns
      // `wrapperModule` (no `.from`), so `fetchAll(supabase, 'roles')`
      // throws before this mock is ever reached.
      expect(client.from).toHaveBeenCalledWith('roles');
      expect(client.from).toHaveBeenCalledWith('role_transitions');
    });
  });
});
