'use strict';

/**
 * modules/student-onboarding/routes/__tests__/recommendation.routes.middleware.test.js
 *
 * HireRise Student MVP Phase 1 Pass 4 — Recommendation Retry/Regeneration
 * CreditGuard, AI rate-limit, and tier-quota wiring.
 *
 * Route-level test: mounts the REAL recommendation.routes.js router (real
 * aiRateLimitByPlan, tierQuota, creditGuard, and controller — nothing about
 * the middleware chain itself is mocked) behind a minimal Express app that
 * stands in for the authenticate + requireOnboardingSession mount in
 * server.js. Only recommendation-engine.js (the lifecycle/DB layer) and the
 * Supabase client each control module talks to are mocked, so this suite
 * exercises the actual wiring/ordering decided by this pass, not a stand-in.
 *
 * Covers spec §16 Tests A-E, I:
 *   A — zero-credit retry passes CreditGuard
 *   B — rate limit applies
 *   C — quota applies
 *   D — middleware ordering (rejected control runs before initiateRetry())
 *   E — authenticated ownership (ids can only ever come from req.user.id)
 *   I — rejected controls do not mutate lifecycle state
 */

const express = require('express');
const request = require('supertest');

jest.mock('../../services/recommendation-engine', () => ({
  initiateRetry: jest.fn(),
}));

jest.mock('../../../../middleware/errorHandler', () => {
  class AppError extends Error {
    constructor(message, statusCode, details, code) {
      super(message);
      this.statusCode = statusCode;
      this.details = details;
      this.code = code;
    }
  }
  return {
    AppError,
    ErrorCodes: {
      UNAUTHORIZED: 'UNAUTHORIZED',
      VALIDATION_ERROR: 'VALIDATION_ERROR',
      INTERNAL_SERVER_ERROR: 'INTERNAL_SERVER_ERROR',
      PAYMENT_REQUIRED: 'PAYMENT_REQUIRED',
    },
  };
});

jest.mock('../../../../utils/logger', () => ({
  debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));

jest.mock('../../../../middleware/requireTier.middleware', () => ({
  normalizeTier: jest.fn((plan) => plan || 'free'),
}));

// Single shared Supabase mock. aiRateLimitByPlan uses .rpc('check_rate_limit'),
// tierQuota uses .from('user_quota').select(...) + .rpc('increment_user_quota'),
// creditGuard uses .rpc('consume_ai_credits') (never reached for a
// zero-cost operation, but stubbed defensively).
const mockRpc = jest.fn();
const mockQuotaSelect = jest.fn();

jest.mock('../../../../config/supabase', () => ({
  supabase: {
    rpc: (...args) => mockRpc(...args),
    from: (table) => {
      if (table === 'user_quota') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () => mockQuotaSelect(),
                }),
              }),
            }),
          }),
        };
      }
      throw new Error(`Unexpected table in test: ${table}`);
    },
  },
}));

const recommendationEngine = require('../../services/recommendation-engine');
const recommendationRoutes = require('../recommendation.routes');

function buildApp({ user = { id: 'user-1', uid: 'user-1', plan: 'pro' } } = {}) {
  const app = express();
  app.use((req, res, next) => {
    if (user) req.user = user;
    next();
  });
  app.use('/api/v1/student-onboarding/v2/recommendation', recommendationRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  });
  return app;
}

describe('recommendation.routes — retry endpoint control wiring (Phase 1 Pass 4)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: rate limit allowed, quota under limit, retry starts.
    mockRpc.mockResolvedValue({ data: true, error: null });
    mockQuotaSelect.mockResolvedValue({ data: { count: 0 }, error: null });
    recommendationEngine.initiateRetry.mockResolvedValue({ started: true, status: 'pending' });
  });

  describe('Test A — zero-credit retry passes CreditGuard', () => {
    it('recognises studentRecommendation, never calls consume_ai_credits, and reaches the controller', async () => {
      const app = buildApp({ user: { id: 'user-1', uid: 'user-1', plan: 'pro' } });

      const res = await request(app).post('/api/v1/student-onboarding/v2/recommendation/retry');

      expect(res.status).toBe(202);
      expect(recommendationEngine.initiateRetry).toHaveBeenCalledWith('user-1');
      // consume_ai_credits (the only RPC creditGuard would call for a paid
      // operation) is never invoked — the only RPC call observed is the
      // rate-limit check.
      expect(mockRpc).toHaveBeenCalledWith('check_rate_limit', expect.any(Object));
      expect(mockRpc).not.toHaveBeenCalledWith('consume_ai_credits', expect.anything());
    });
  });

  describe('Test B — rate limit applies', () => {
    it('a rate-limited request is rejected with 429, never reaches initiateRetry()', async () => {
      mockRpc.mockResolvedValue({ data: false, error: null }); // check_rate_limit denies

      const app = buildApp();
      const res = await request(app).post('/api/v1/student-onboarding/v2/recommendation/retry');

      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('RATE_LIMITED');
      expect(recommendationEngine.initiateRetry).not.toHaveBeenCalled();
    });
  });

  describe('Test C — quota applies', () => {
    it('a quota-exhausted free-tier request is rejected with 429, never reaches initiateRetry()', async () => {
      // free tier, unregistered feature -> falls back to TIER_MONTHLY_QUOTAS.free.default (10)
      mockQuotaSelect.mockResolvedValue({ data: { count: 10 }, error: null });

      const app = buildApp({ user: { id: 'user-1', uid: 'user-1', plan: 'free' } });
      const res = await request(app).post('/api/v1/student-onboarding/v2/recommendation/retry');

      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('TIER_INSUFFICIENT');
      expect(recommendationEngine.initiateRetry).not.toHaveBeenCalled();
    });

    // AUDIT UPDATE (Tier Quota Fallback Semantics pass): the
    // `conf.default ?? 10` bug this comment used to describe has now been
    // fixed in tierquota.middleware.js — an explicitly-configured
    // `default: null` (pro/enterprise/premium) is this codebase's
    // established "unmetered" convention (see that file's getQuotaLimit()
    // for the full evidence trail) and is no longer coerced into a
    // numeric 10 cap. A pro-tier request for studentRecommendation (which
    // has no explicit per-feature override in any tier) is therefore
    // unmetered: tierQuota bypasses the quota check entirely, so the
    // Supabase quota lookup is never even made.
    it('a pro-tier request is unmetered for an unregistered feature (tierQuota fallback fix)', async () => {
      // No explicit per-feature override exists for studentRecommendation
      // in ANY tier, so pro resolves via TIER_MONTHLY_QUOTAS.pro.default,
      // which is explicitly `null` — set an implausibly-high count to
      // prove the quota check path isn't merely passing by chance.
      mockQuotaSelect.mockResolvedValue({ data: { count: 999999 }, error: null });

      const app = buildApp({ user: { id: 'user-1', uid: 'user-1', plan: 'pro' } });
      const res = await request(app).post('/api/v1/student-onboarding/v2/recommendation/retry');

      expect(res.status).toBe(202);
      expect(recommendationEngine.initiateRetry).toHaveBeenCalledWith('user-1');
      // The quota table is never even queried for an unmetered tier.
      expect(mockQuotaSelect).not.toHaveBeenCalled();
    });

    it('an enterprise-tier request is likewise unmetered for an unregistered feature', async () => {
      mockQuotaSelect.mockResolvedValue({ data: { count: 999999 }, error: null });

      const app = buildApp({ user: { id: 'user-1', uid: 'user-1', plan: 'enterprise' } });
      const res = await request(app).post('/api/v1/student-onboarding/v2/recommendation/retry');

      expect(res.status).toBe(202);
      expect(recommendationEngine.initiateRetry).toHaveBeenCalledWith('user-1');
      expect(mockQuotaSelect).not.toHaveBeenCalled();
    });

    // PAYG Entitlement Architecture audit: elite now carries its own
    // `default: null` entry in TIER_MONTHLY_QUOTAS (see
    // tierquota.middleware.js), closing the gap where it previously fell
    // back to the free tier's numeric caps entirely.
    it('an elite-tier request is also unmetered — no more falling back to free-tier caps', async () => {
      mockQuotaSelect.mockResolvedValue({ data: { count: 999999 }, error: null });

      const app = buildApp({ user: { id: 'user-1', uid: 'user-1', plan: 'elite' } });
      const res = await request(app).post('/api/v1/student-onboarding/v2/recommendation/retry');

      expect(res.status).toBe(202);
      expect(recommendationEngine.initiateRetry).toHaveBeenCalledWith('user-1');
      expect(mockQuotaSelect).not.toHaveBeenCalled();
    });
  });

  describe('Test D — middleware ordering / Test I — rejected controls do not mutate state', () => {
    it('rate-limit rejection short-circuits before tierQuota/creditGuard/controller run', async () => {
      mockRpc.mockResolvedValue({ data: false, error: null });

      const app = buildApp();
      await request(app).post('/api/v1/student-onboarding/v2/recommendation/retry');

      // Only the rate-limit RPC ran — quota's select and initiateRetry were
      // never reached, proving aiRateLimitByPlan executes first and a
      // rejection prevents every control (and the lifecycle mutation) after it.
      expect(mockQuotaSelect).not.toHaveBeenCalled();
      expect(recommendationEngine.initiateRetry).not.toHaveBeenCalled();
    });

    it('quota rejection runs after rate-limit passes but still short-circuits before the controller', async () => {
      mockRpc.mockResolvedValue({ data: true, error: null }); // rate limit allows
      mockQuotaSelect.mockResolvedValue({ data: { count: 10 }, error: null }); // quota denies

      const app = buildApp({ user: { id: 'user-1', uid: 'user-1', plan: 'free' } });
      await request(app).post('/api/v1/student-onboarding/v2/recommendation/retry');

      expect(mockRpc).toHaveBeenCalledWith('check_rate_limit', expect.any(Object));
      expect(mockQuotaSelect).toHaveBeenCalled();
      expect(recommendationEngine.initiateRetry).not.toHaveBeenCalled();
    });
  });

  describe('Test E — authenticated ownership', () => {
    it('unauthenticated requests are rejected before any control runs', async () => {
      const app = buildApp({ user: null });
      const res = await request(app).post('/api/v1/student-onboarding/v2/recommendation/retry');

      expect(res.status).toBe(401);
      expect(recommendationEngine.initiateRetry).not.toHaveBeenCalled();
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('no client-supplied id in body/params/query ever reaches initiateRetry()', async () => {
      const app = buildApp({ user: { id: 'user-1', uid: 'user-1', plan: 'pro' } });

      await request(app)
        .post('/api/v1/student-onboarding/v2/recommendation/retry')
        .send({ userId: 'someone-elses-id', user_id: 'also-someone-elses-id' });

      expect(recommendationEngine.initiateRetry).toHaveBeenCalledTimes(1);
      expect(recommendationEngine.initiateRetry).toHaveBeenCalledWith('user-1');
    });
  });
});
