'use strict';

/**
 * modules/knowledge-runtime/recommendation/__tests__/recommendation.controller.test.js
 */

const mockService = {
  generateRecommendationCandidates: jest.fn(),
};

jest.mock('../../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../../knowledge-runtime.module', () => ({
  getRecommendationService: () => mockService,
}));

const controller = require('../recommendation.controller');

function makeRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

describe('recommendation.controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getMyRecommendations', () => {
    it('resolves userId from req.user.id and calls the service with no groups filter by default', async () => {
      // WP-XAI2-03: the service's raw result still carries `userId` (see the
      // service's own object shape, untouched by this WP) — but the public
      // response contract does not. `expect.objectContaining` is used at the
      // top level because WP-XAI2-02's `meta` (dynamic timestamp/requestId)
      // is additive and out of this WP's scope to assert on exactly.
      mockService.generateRecommendationCandidates.mockResolvedValue({
        userId: 'user-1',
        skillRecommendations: { available: true, candidates: [] },
      });
      const req = { user: { id: 'user-1' }, query: {} };
      const res = makeRes();
      const next = jest.fn();

      await controller.getMyRecommendations(req, res, next);

      expect(mockService.generateRecommendationCandidates).toHaveBeenCalledWith('user-1', { groups: null });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: { skillRecommendations: { available: true, candidates: [] } },
        }),
      );
    });

    // WP-XAI2-03 regression coverage: the controller's `_toPublicRecommendations`
    // filter must strip `userId` even though the service continues to return
    // it internally (see recommendation.service.js line ~150 — unmodified).
    // This is the test that actually protects the fix in
    // recommendation.controller.js from silent reversion.
    it('WP-XAI2-03 regression: never exposes userId, even when the service returns it', async () => {
      mockService.generateRecommendationCandidates.mockResolvedValue({
        userId: 'user-1',
        skillRecommendations: { available: true, candidates: [] },
      });
      const req = { user: { id: 'user-1' }, query: {} };
      const res = makeRes();
      const next = jest.fn();

      await controller.getMyRecommendations(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data).not.toHaveProperty('userId');
      expect(JSON.stringify(body)).not.toContain('user-1');
    });

    it('parses a comma-separated groups query param', async () => {
      mockService.generateRecommendationCandidates.mockResolvedValue({ userId: 'user-1' });
      const req = { user: { id: 'user-1' }, query: { groups: 'skill,career' } };
      const res = makeRes();
      const next = jest.fn();

      await controller.getMyRecommendations(req, res, next);

      expect(mockService.generateRecommendationCandidates).toHaveBeenCalledWith('user-1', {
        groups: ['skill', 'career'],
      });
    });

    it('forwards a validation error to next() when req.user is missing', async () => {
      const req = { user: undefined, query: {} };
      const res = makeRes();
      const next = jest.fn();

      await controller.getMyRecommendations(req, res, next);

      expect(mockService.generateRecommendationCandidates).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });

    it('rejects an invalid group name', async () => {
      const req = { user: { id: 'user-1' }, query: { groups: 'not-a-real-group' } };
      const res = makeRes();
      const next = jest.fn();

      await controller.getMyRecommendations(req, res, next);

      expect(mockService.generateRecommendationCandidates).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });

    it('forwards service errors to next()', async () => {
      mockService.generateRecommendationCandidates.mockRejectedValue(new Error('boom'));
      const req = { user: { id: 'user-1' }, query: {} };
      const res = makeRes();
      const next = jest.fn();

      await controller.getMyRecommendations(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });
});
