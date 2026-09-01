'use strict';

/**
 * @file graphIntelligence.simulatePath.regression.test.js
 * @description WP-ADMIN-COMP-12A — backend verification and regression
 * coverage for the existing `POST /simulate-path` capability
 * (graphIntelligence.controller.js `simulatePath`), before any frontend
 * work is planned.
 *
 * This file proves the ACTUAL implemented behavior via source-grounded
 * tests — it does not assume or impose semantics the code doesn't already
 * have. Two behavioral quirks were discovered during inspection and are
 * deliberately encoded (not "fixed") below, each with an explanatory
 * comment at the relevant test:
 *
 *   1. `max_hops` boundary is looser than the name implies. The skip
 *      condition is `path.length > max_hops + 1`, where `path.length`
 *      counts NODES (source counts as 1), so it skips only once the hop
 *      count (path.length - 1) exceeds max_hops. A node at exactly
 *      max_hops hops is still expanded, so a target discovered as ITS
 *      neighbor is returned at max_hops + 1 total hops — one hop beyond
 *      what "max_hops" would naively suggest as a hard ceiling. This is
 *      reported as observed behavior, not fixed: whether "max_hops" means
 *      "hop count is capped at this value" or "at most this many hops of
 *      expansion, plus the edge that finds the target" is a semantic
 *      question the source alone doesn't resolve, and changing it would
 *      alter real search results — exactly the kind of change this work
 *      package's guardrails say not to make without a demonstrated,
 *      unambiguous defect.
 *
 *   2. Source-equals-target is NOT short-circuited. The algorithm never
 *      checks "is `current` already the target" before expanding —  it
 *      only checks whether a NEIGHBOR of `current` equals the target. So
 *      `current_role_id === target_role_id` with no self-loop or cycle
 *      back to that same id produces `found: false`, not an immediate
 *      trivial match. This is encoded exactly as observed.
 *
 * Regression-test conventions (mocked chainable Supabase client, module
 * shape, `invokeAsyncHandler`) follow graphSupabaseClientAccess.regression
 * .test.js and graphIntelligence.searchRoles.regression.test.js exactly.
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
 * Chainable builder for the `role_transitions` query, which the
 * implementation calls as a plain `.from('role_transitions').select(...)`
 * with no `.eq`/`.in`/`.limit` — the entire table is always fetched. This
 * builder supports exactly that shape (thenable after `.select()`), plus
 * enough surface to reject with a Supabase-style error object.
 */
function chainableTransitionsBuilder(result) {
  const builder = {
    select: () => builder,
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

// asyncHandler (utils/helpers.js) does `Promise.resolve().then(() =>
// fn(req, res, next)).catch(next)` and does not return that promise — a
// plain `await handler(...)` resolves before the handler's own async work
// has run. This resolves once res.json is called (success path) or
// rejects with whatever `next` receives (failure path), matching how
// Express actually drives the handler either way.
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

function transitionsOf(pairs) {
  return { data: pairs.map(([from_role_id, to_role_id]) => ({ from_role_id, to_role_id })), error: null };
}

async function runSimulatePath(transitionsResult, body) {
  const { wrapperModule } = makeRealShapedSupabaseModule(() => chainableTransitionsBuilder(transitionsResult));
  jest.doMock('../../../../config/supabase', () => wrapperModule);

  const { simulatePath } = require('../graphIntelligence.controller');
  const req = { body };
  const res = makeRes();
  await invokeAsyncHandler(simulatePath, req, res);
  return res;
}

describe('graphIntelligence.controller.js — simulatePath (WP-ADMIN-COMP-12A)', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  it('finds a direct A → B path', async () => {
    const res = await runSimulatePath(transitionsOf([['A', 'B']]), {
      current_role_id: 'A',
      target_role_id: 'B',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      meta: { duration_ms: expect.any(Number) },
      data: { found: true, path: ['A', 'B'] },
    });
  });

  it('finds a multi-hop A → B → C → D path in correct source-to-target order', async () => {
    const res = await runSimulatePath(
      transitionsOf([
        ['A', 'B'],
        ['B', 'C'],
        ['C', 'D'],
      ]),
      { current_role_id: 'A', target_role_id: 'D', max_hops: 6 },
    );

    expect(res.body.data.found).toBe(true);
    expect(res.body.data.path).toEqual(['A', 'B', 'C', 'D']);
  });

  it('returns found: false with an empty path when no route connects source to target', async () => {
    const res = await runSimulatePath(
      transitionsOf([
        ['A', 'B'],
        ['X', 'Y'], // disconnected component — no route reaches D
      ]),
      { current_role_id: 'A', target_role_id: 'D' },
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({ found: false, path: [] });
  });

  it('terminates and does not loop forever on a cycle (A → B → C → A)', async () => {
    const res = await runSimulatePath(
      transitionsOf([
        ['A', 'B'],
        ['B', 'C'],
        ['C', 'A'],
      ]),
      { current_role_id: 'A', target_role_id: 'Z' }, // unreachable — forces full traversal of the cycle
    );

    // Proves termination: if the visited-set protection failed, this
    // would hang and the test would time out rather than resolve.
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({ found: false, path: [] });
  });

  it('finds the intended route through a cycle when the target IS reachable', async () => {
    const res = await runSimulatePath(
      transitionsOf([
        ['A', 'B'],
        ['B', 'C'],
        ['C', 'A'],
        ['C', 'D'],
      ]),
      { current_role_id: 'A', target_role_id: 'D' },
    );

    expect(res.body.data).toEqual({ found: true, path: ['A', 'B', 'C', 'D'] });
  });

  it('prefers the shortest-hop route when both a direct and a longer path exist (BFS guarantee)', async () => {
    const res = await runSimulatePath(
      transitionsOf([
        ['A', 'D'], // 1 hop
        ['A', 'B'],
        ['B', 'C'],
        ['C', 'D'], // 3 hops, also valid
      ]),
      { current_role_id: 'A', target_role_id: 'D' },
    );

    expect(res.body.data).toEqual({ found: true, path: ['A', 'D'] });
  });

  describe('max_hops boundary — observed behavior, not a demonstrated defect (see file header)', () => {
    it('finds a path at exactly max_hops (2 hops, max_hops: 2)', async () => {
      const res = await runSimulatePath(
        transitionsOf([
          ['A', 'B'],
          ['B', 'C'],
        ]),
        { current_role_id: 'A', target_role_id: 'C', max_hops: 2 },
      );

      expect(res.body.data).toEqual({ found: true, path: ['A', 'B', 'C'] });
    });

    it('ALSO finds a path at max_hops + 1 (2 hops, max_hops: 1) — the boundary is looser than the name suggests', async () => {
      const res = await runSimulatePath(
        transitionsOf([
          ['A', 'B'],
          ['B', 'C'],
        ]),
        { current_role_id: 'A', target_role_id: 'C', max_hops: 1 },
      );

      // Documented, source-grounded observation: with max_hops: 1, a path
      // requiring 2 hops is still returned. See file header comment #1.
      expect(res.body.data).toEqual({ found: true, path: ['A', 'B', 'C'] });
    });

    it('does not find a path requiring max_hops + 2 hops', async () => {
      const res = await runSimulatePath(
        transitionsOf([
          ['A', 'B'],
          ['B', 'C'],
          ['C', 'D'],
        ]),
        { current_role_id: 'A', target_role_id: 'D', max_hops: 1 }, // D is 3 hops away
      );

      expect(res.body.data).toEqual({ found: false, path: [] });
    });

    it('uses the default max_hops of 6 when max_hops is omitted', async () => {
      const chain = [];
      for (let i = 0; i < 6; i += 1) chain.push([`N${i}`, `N${i + 1}`]); // 6 hops, N0..N6
      const res = await runSimulatePath(transitionsOf(chain), {
        current_role_id: 'N0',
        target_role_id: 'N6',
      });

      expect(res.body.data.found).toBe(true);
    });
  });

  describe('source equals target — observed behavior, not a demonstrated defect (see file header)', () => {
    it('returns found: false when source equals target and no self-loop or cycle exists', async () => {
      const res = await runSimulatePath(transitionsOf([['A', 'B']]), {
        current_role_id: 'A',
        target_role_id: 'A',
      });

      // No trivial "already there" short-circuit exists in the source —
      // the algorithm only checks neighbors, never the starting node
      // itself. See file header comment #2.
      expect(res.body.data).toEqual({ found: false, path: [] });
    });

    it('returns found: true via a genuine self-loop transition (A → A)', async () => {
      const res = await runSimulatePath(transitionsOf([['A', 'A']]), {
        current_role_id: 'A',
        target_role_id: 'A',
      });

      expect(res.body.data).toEqual({ found: true, path: ['A', 'A'] });
    });
  });

  it('handles an empty transition set without throwing, returning found: false', async () => {
    const res = await runSimulatePath(transitionsOf([]), {
      current_role_id: 'A',
      target_role_id: 'B',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({ found: false, path: [] });
  });

  it('propagates a database/query failure to Express error handling — never as found: false', async () => {
    const dbError = Object.assign(new Error('connection terminated'), { code: '57P01' });
    let caughtError = null;

    try {
      await runSimulatePath({ data: null, error: dbError }, { current_role_id: 'A', target_role_id: 'B' });
    } catch (err) {
      caughtError = err;
    }

    // Proves the failure reached `next(err)` (rejecting invokeAsyncHandler's
    // promise) rather than being silently converted into a 200 response.
    expect(caughtError).toBe(dbError);
  });

  // Request validation (missing current_role_id/target_role_id, or
  // max_hops outside 1-8) is enforced by the `validate([...])` chain in
  // graphIntelligence.routes.js as Express middleware BEFORE
  // `ctrl.simulatePath` runs — confirmed by direct source inspection, not
  // by a unit test here. This module's established test convention
  // invokes the controller function directly, bypassing the Express
  // router entirely, so that middleware layer isn't reachable from this
  // file's test harness without a different, integration-style setup
  // that no existing test in this module uses. This is reported as
  // "verified from source" in the final report rather than fabricated as
  // executed coverage.
});
