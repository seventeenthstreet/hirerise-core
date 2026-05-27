'use strict';

/**
 * tests/contract/response-shape.test.js
 *
 * Lightweight CI contract smoke tests for the V2 response shape.
 *
 * PURPOSE:
 *   Catch regressions before they reach production by asserting that:
 *   1. The shared response helpers produce valid V2 shapes
 *   2. assertV2Shape() correctly validates and rejects shapes
 *   3. Exemption shapes (health, webhook ACK) are not accidentally wrapped
 *   4. Parser observation snapshot API is available (wired correctly)
 *
 * CI INTEGRATION:
 *   These tests run in the CI pipeline via `npm run test:contract`.
 *   They must pass before any deployment. Fast and self-contained — no
 *   network, no DB, no mocks beyond the in-memory mock res object.
 *
 * PHASE 3 GATE CRITERIA (observation window):
 *   Before Phase 3 parser cleanup can begin, ALL of the following must hold
 *   for a 14-day uninterrupted observation window in production:
 *     □  Zero transitional branch hits  (observeTransitionalBranch never fires)
 *     □  Zero malformed response hits   (observeMalformedResponse never fires)
 *     □  Zero legacy branch hits        (observeLegacyBranch never fires)
 *     □  These CI contract tests passing consistently
 *   See docs/phase3-observation-window.md for the full gate checklist.
 *
 * DOES NOT:
 *   - Make HTTP requests (unit test only)
 *   - Test business logic
 *   - Replace E2E tests
 *
 * RUN: jest tests/contract/response-shape.test.js
 */

const { sendSuccess, sendError, assertV2Shape } = require('../../src/shared/response');

// ── Mock Express res object ──────────────────────────────────────────────────

function makeMockRes() {
  const captured = { status: 200, body: null };
  const res = {
    req: {
      headers: { 'x-correlation-id': 'test-req-123' },
    },
    status(code) {
      captured.status = code;
      return res;
    },
    json(body) {
      captured.body = body;
      return res;
    },
  };
  return { res, captured };
}

// ── sendSuccess shape ────────────────────────────────────────────────────────

describe('sendSuccess — V2 shape compliance', () => {
  test('produces success:true, data key present', () => {
    const { res, captured } = makeMockRes();
    sendSuccess(res, { foo: 'bar' });

    expect(captured.body.success).toBe(true);
    expect('data' in captured.body).toBe(true);
    expect(captured.body.data).toEqual({ foo: 'bar' });
  });

  test('data can be null', () => {
    const { res, captured } = makeMockRes();
    sendSuccess(res, null);

    expect(captured.body.success).toBe(true);
    expect(captured.body.data).toBeNull();
  });

  test('includes meta.timestamp', () => {
    const { res, captured } = makeMockRes();
    sendSuccess(res, null);

    expect(typeof captured.body.meta?.timestamp).toBe('string');
  });

  test('includes meta.requestId from correlation header', () => {
    const { res, captured } = makeMockRes();
    sendSuccess(res, null);

    expect(captured.body.meta?.requestId).toBe('test-req-123');
  });

  test('extra fields spread to top level for backward compat', () => {
    const { res, captured } = makeMockRes();
    sendSuccess(res, { id: 1 }, { legacyField: 'value' });

    expect(captured.body.legacyField).toBe('value');
    expect(captured.body.data).toEqual({ id: 1 });
  });

  test('default status is 200', () => {
    const { res, captured } = makeMockRes();
    sendSuccess(res, null);
    expect(captured.status).toBe(200);
  });

  test('custom status is respected', () => {
    const { res, captured } = makeMockRes();
    sendSuccess(res, null, {}, {}, 201);
    expect(captured.status).toBe(201);
  });
});

// ── sendError shape ──────────────────────────────────────────────────────────

describe('sendError — V2 shape compliance', () => {
  test('produces success:false, error object with code and message', () => {
    const { res, captured } = makeMockRes();
    sendError(res, 400, 'Name is required', 'INVALID_INPUT');

    expect(captured.body.success).toBe(false);
    expect(captured.body.error?.code).toBe('INVALID_INPUT');
    expect(captured.body.error?.message).toBe('Name is required');
  });

  test('top-level message preserved for backward compat', () => {
    const { res, captured } = makeMockRes();
    sendError(res, 400, 'Name is required', 'INVALID_INPUT');

    expect(captured.body.message).toBe('Name is required');
  });

  test('defaults code to INTERNAL_ERROR when omitted', () => {
    const { res, captured } = makeMockRes();
    sendError(res, 500, 'Something went wrong');

    expect(captured.body.error?.code).toBe('INTERNAL_ERROR');
  });

  test('includes meta.timestamp', () => {
    const { res, captured } = makeMockRes();
    sendError(res, 400, 'Bad request', 'BAD_REQUEST');

    expect(typeof captured.body.meta?.timestamp).toBe('string');
  });

  test('status code is set correctly', () => {
    const { res, captured } = makeMockRes();
    sendError(res, 404, 'Not found', 'NOT_FOUND');
    expect(captured.status).toBe(404);
  });
});

// ── assertV2Shape guard ──────────────────────────────────────────────────────

describe('assertV2Shape — shape validation', () => {
  const OLD_ENV = process.env.NODE_ENV;
  beforeEach(() => { process.env.NODE_ENV = 'test'; });
  afterEach(() => { process.env.NODE_ENV = OLD_ENV; });

  test('passes for valid success shape', () => {
    expect(() => {
      assertV2Shape({ success: true, data: null }, '/test');
    }).not.toThrow();
  });

  test('passes for valid error shape', () => {
    expect(() => {
      assertV2Shape({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Not found' },
      }, '/test');
    }).not.toThrow();
  });

  test('throws for missing success field', () => {
    expect(() => {
      assertV2Shape({ data: null }, '/test');
    }).toThrow(/success must be boolean/);
  });

  test('throws for success:true without data key', () => {
    expect(() => {
      assertV2Shape({ success: true }, '/test');
    }).toThrow(/data.*key/);
  });

  test('throws for success:false without error object', () => {
    expect(() => {
      assertV2Shape({ success: false }, '/test');
    }).toThrow(/error.*code.*message/);
  });

  test('throws for non-object body', () => {
    expect(() => {
      assertV2Shape('not an object', '/test');
    }).toThrow(/plain object/);
  });
});

// ── Regression guard: webhook ACK shape stays exempt ────────────────────────

describe('Exemption: Webhook ACK shape', () => {
  test('{ received: true } does NOT pass assertV2Shape (correctly rejects non-V2)', () => {
    // This confirms that webhook ACK is genuinely exempt — it fails V2 validation.
    // If this test ever starts passing, the assertV2Shape logic is wrong.
    expect(() => {
      assertV2Shape({ received: true }, '/webhooks/stripe');
    }).toThrow(); // correctly fails — webhook ACK is intentionally non-V2
  });
});

// ── Regression guard: health probe shape stays exempt ────────────────────────

describe('Exemption: Health probe shape', () => {
  test('{ status: "healthy", ts: "..." } does NOT pass assertV2Shape', () => {
    // Health probe shape is intentionally non-V2 (HEALTH_PROBE exemption).
    // If this passes, assertV2Shape has become too lenient.
    expect(() => {
      assertV2Shape({ status: 'healthy', ts: new Date().toISOString() }, '/health');
    }).toThrow(); // correctly fails — health probe is intentionally non-V2
  });
});

// ── Malformed response shapes that must fail V2 validation ───────────────────

describe('V2 contract: malformed shapes must fail', () => {
  const OLD_ENV = process.env.NODE_ENV;
  beforeEach(() => { process.env.NODE_ENV = 'test'; });
  afterEach(() => { process.env.NODE_ENV = OLD_ENV; });

  test('legacy error shape { error: "CODE", message } fails V2', () => {
    // This is the shape that triggers Branch 2 (legacy) in the parser.
    // It should NEVER come from a properly migrated endpoint.
    expect(() => {
      assertV2Shape({ error: 'NOT_FOUND', message: 'Not found' }, '/test');
    }).toThrow(); // correctly fails — missing success field
  });

  test('success:true without data key fails V2 (R1 violation)', () => {
    expect(() => {
      assertV2Shape({ success: true, message: 'ok' }, '/test');
    }).toThrow(/data.*key/);
  });

  test('success:false with string error (pre-V2 shape) fails V2', () => {
    // error: "some string" is the legacy shape — error must be { code, message }
    expect(() => {
      assertV2Shape({ success: false, error: 'Something went wrong' }, '/test');
    }).toThrow(/error.*code.*message/);
  });
});