'use strict';

/**
 * modules/knowledge-runtime/validation/__tests__/validation.controller.test.js
 */

const mockService = {
  validateDecisionReadiness: jest.fn(),
};

jest.mock('../../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../../knowledge-runtime.module', () => ({
  getValidationService: () => mockService,
}));

const controller = require('../validation.controller');

function makeRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

describe('validation.controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getMyValidation', () => {
    it('resolves userId from req.user.id and calls the service', async () => {
      // WP-XAI2-03: the service's raw ValidationResult still carries `userId`
      // (validation.service.js line ~235 — unmodified), but the public
      // response contract does not. `expect.objectContaining` is used at the
      // top level because WP-XAI2-02's `meta` (dynamic timestamp/requestId)
      // is additive and out of this WP's scope to assert on exactly.
      mockService.validateDecisionReadiness.mockResolvedValue({ userId: 'user-1', valid: true });
      const req = { user: { id: 'user-1' } };
      const res = makeRes();
      const next = jest.fn();

      await controller.getMyValidation(req, res, next);

      expect(mockService.validateDecisionReadiness).toHaveBeenCalledWith('user-1');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, data: { valid: true } }),
      );
    });

    // WP-XAI2-03 regression coverage: the controller's `_toPublicValidation`
    // filter must strip `userId` even though the service continues to return
    // it internally. This is the test that actually protects the fix in
    // validation.controller.js from silent reversion.
    it('WP-XAI2-03 regression: never exposes userId, even when the service returns it', async () => {
      mockService.validateDecisionReadiness.mockResolvedValue({ userId: 'user-1', valid: true, score: 0.9 });
      const req = { user: { id: 'user-1' } };
      const res = makeRes();
      const next = jest.fn();

      await controller.getMyValidation(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data).not.toHaveProperty('userId');
      expect(JSON.stringify(body)).not.toContain('user-1');
    });

    it('forwards a validation error to next() when req.user is missing', async () => {
      const req = { user: undefined };
      const res = makeRes();
      const next = jest.fn();

      await controller.getMyValidation(req, res, next);

      expect(mockService.validateDecisionReadiness).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });

    it('forwards service errors to next()', async () => {
      mockService.validateDecisionReadiness.mockRejectedValue(new Error('boom'));
      const req = { user: { id: 'user-1' } };
      const res = makeRes();
      const next = jest.fn();

      await controller.getMyValidation(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });
});
