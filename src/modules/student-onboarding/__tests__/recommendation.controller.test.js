'use strict';

/**
 * modules/student-onboarding/__tests__/recommendation.controller.test.js
 *
 * Focus: HTTP adapter correctness, identity/ownership, and client-input
 * rejection for the Recommendation retry/regeneration endpoint — the
 * security-critical part of this layer. Lifecycle/concurrency logic itself
 * is covered by recommendation-engine.test.js.
 */

jest.mock('../services/recommendation-engine');

const recommendationEngine = require('../services/recommendation-engine');
const { retryRecommendation } = require('../controllers/recommendation.controller');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('recommendation.controller', () => {
  afterEach(() => jest.clearAllMocks());

  describe('retryRecommendation', () => {
    // Test H (unauthenticated) is enforced upstream by the `authenticate`
    // middleware at the server.js mount point — this controller is never
    // reached without a verified req.user, matching every other v2 step
    // controller's convention (see aspiration.controller.js). Nothing
    // controller-specific to test here beyond identity derivation below.

    it('Test I — derives identity from req.user.id only, never from req.body/req.params', async () => {
      recommendationEngine.initiateRetry.mockResolvedValue({ started: true, status: 'pending' });

      const req = {
        user: { id: 'authenticated-user-id' },
        // A client attempting IDOR by supplying a different user id — must
        // be completely ignored.
        body: { userId: 'someone-elses-id', user_id: 'also-someone-elses-id' },
        params: { userId: 'someone-elses-id' },
      };
      const res = mockRes();
      const next = jest.fn();

      await retryRecommendation(req, res, next);

      expect(recommendationEngine.initiateRetry).toHaveBeenCalledTimes(1);
      expect(recommendationEngine.initiateRetry).toHaveBeenCalledWith('authenticated-user-id');
    });

    it('Test J — client input cannot set status/credit/result: the controller never reads req.body at all', async () => {
      recommendationEngine.initiateRetry.mockResolvedValue({ started: true, status: 'pending' });

      const req = {
        user: { id: 'user-1' },
        body: {
          status: 'ready',
          creditCost: 0,
          result: { fake: true },
          resultJson: '{}',
          careerAreaKey: 'technology',
          contextVersion: 'attacker-supplied',
        },
      };
      const res = mockRes();
      const next = jest.fn();

      await retryRecommendation(req, res, next);

      // Only the authenticated userId is ever forwarded — none of the body
      // fields above reach initiateRetry.
      expect(recommendationEngine.initiateRetry).toHaveBeenCalledWith('user-1');
      expect(recommendationEngine.initiateRetry).not.toHaveBeenCalledWith(
        expect.objectContaining({ status: expect.anything() }),
      );
    });

    it('Test K — returns 202 without waiting for generation to complete (non-blocking)', async () => {
      recommendationEngine.initiateRetry.mockResolvedValue({ started: true, status: 'pending' });

      const req = { user: { id: 'user-1' }, body: {} };
      const res = mockRes();
      const next = jest.fn();

      await retryRecommendation(req, res, next);

      expect(res.status).toHaveBeenCalledWith(202);
      expect(res.json).toHaveBeenCalledWith({ ok: true, status: 'pending' });
      // No provider/generation internals ever appear in the response.
      expect(res.json).not.toHaveBeenCalledWith(
        expect.objectContaining({ result: expect.anything() }),
      );
    });

    it('acknowledges an already-in-progress retry with 200 (idempotent), not an error', async () => {
      recommendationEngine.initiateRetry.mockResolvedValue({ started: false, status: 'pending' });

      const req = { user: { id: 'user-1' }, body: {} };
      const res = mockRes();
      const next = jest.fn();

      await retryRecommendation(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ ok: true, status: 'pending' });
    });

    it('returns 409 when nothing is eligible to retry (no result yet / not_started)', async () => {
      recommendationEngine.initiateRetry.mockResolvedValue({ started: false, status: null });

      const req = { user: { id: 'user-1' }, body: {} };
      const res = mockRes();
      const next = jest.fn();

      await retryRecommendation(req, res, next);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith({
        ok: false,
        error: expect.any(String),
      });
    });

    it('never exposes provider errors directly: forwards engine errors to next() rather than throwing or leaking details', async () => {
      const err = new Error('Failed to initiate recommendation retry: connection reset');
      recommendationEngine.initiateRetry.mockRejectedValue(err);

      const req = { user: { id: 'user-1' }, body: {} };
      const res = mockRes();
      const next = jest.fn();

      await retryRecommendation(req, res, next);

      expect(next).toHaveBeenCalledWith(err);
      expect(res.status).not.toHaveBeenCalled();
    });
  });
});
