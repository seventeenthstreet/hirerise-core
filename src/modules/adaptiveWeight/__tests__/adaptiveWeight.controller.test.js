'use strict';

/**
 * adaptiveWeight.controller.test.js — WP-ADMIN-COMP-AW-03 §21
 *
 * Includes an explicit regression test for the pre-AW-03 defect (§10):
 * `instanceof AdaptiveWeightValidationError` threw a TypeError because the
 * validator does not export that identifier, so every validation failure
 * crashed instead of returning HTTP 422.
 */

const AdaptiveWeightController = require('../adaptiveWeight.controller');

function makeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function validationError(message = 'invalid') {
  const err = new Error(message);
  err.name = 'AdaptiveWeightValidationError';
  err.details = ['bad field'];
  return err;
}

describe('AdaptiveWeightController — WP-ADMIN-COMP-AW-03', () => {
  let service;
  let controller;
  let res;
  let next;

  beforeEach(() => {
    service = {
      getWeightsForScoring: jest.fn(),
      recordOutcome: jest.fn(),
      applyManualOverride: jest.fn(),
      releaseManualOverride: jest.fn(),
    };
    controller = new AdaptiveWeightController({ adaptiveWeightService: service });
    res = makeRes();
    next = jest.fn();
  });

  describe('validation error handling (regression for §10 defect)', () => {
    it('does NOT throw "instanceof is not callable" and returns HTTP 422 with the expected shape', async () => {
      service.getWeightsForScoring.mockRejectedValue(validationError('roleFamily must be a non-empty string.'));

      const req = { query: {}, headers: {} };

      await expect(controller.getWeights(req, res, next)).resolves.toBeDefined();

      expect(res.status).toHaveBeenCalledWith(422);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'roleFamily must be a non-empty string.',
          details: ['bad field'],
        })
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('produces HTTP 422 for a validation error on every mutating route', async () => {
      service.recordOutcome.mockRejectedValue(validationError());
      service.applyManualOverride.mockRejectedValue(validationError());
      service.releaseManualOverride.mockRejectedValue(validationError());

      const req = { body: {}, headers: {}, user: { id: 'admin-1' }, ip: '203.0.113.9' };

      await controller.recordOutcome(req, res, next);
      expect(res.status).toHaveBeenCalledWith(422);

      res.status.mockClear();
      await controller.applyOverride(req, res, next);
      expect(res.status).toHaveBeenCalledWith(422);

      res.status.mockClear();
      await controller.releaseOverride(req, res, next);
      expect(res.status).toHaveBeenCalledWith(422);
    });
  });

  describe('generic errors', () => {
    it('calls next(err) for a non-validation error rather than sending a response', async () => {
      const genericErr = new Error('unexpected failure');
      service.getWeightsForScoring.mockRejectedValue(genericErr);

      const req = { query: {}, headers: {} };
      await controller.getWeights(req, res, next);

      expect(next).toHaveBeenCalledWith(genericErr);
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe('successful responses', () => {
    it('preserves the existing success response shape', async () => {
      service.getWeightsForScoring.mockResolvedValue({ weights: {}, source: 'default', meta: {} });

      const req = { query: {}, headers: {} };
      await controller.getWeights(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: { weights: {}, source: 'default', meta: {} },
        })
      );
    });

    it('threads req.user.id and req.ip into the override service payload, never from body/query', async () => {
      service.applyManualOverride.mockResolvedValue({ weights: {}, manualOverride: true });

      const req = {
        body: { roleFamily: 'engineering', experienceBucket: '3-5', industryTag: 'fintech', weights: {}, adminId: 'spoofed-admin' },
        headers: {},
        user: { id: 'real-admin' },
        ip: '203.0.113.9',
      };

      await controller.applyOverride(req, res, next);

      const payload = service.applyManualOverride.mock.calls[0][0];
      expect(payload.adminId).toBe('real-admin');
      expect(payload.ipAddress).toBe('203.0.113.9');
    });

    it('threads req.user.id and req.ip into the release service payload', async () => {
      service.releaseManualOverride.mockResolvedValue({ released: true });

      const req = {
        body: { roleFamily: 'engineering', experienceBucket: '3-5', industryTag: 'fintech' },
        headers: {},
        user: { id: 'real-admin' },
        ip: '203.0.113.9',
      };

      await controller.releaseOverride(req, res, next);

      const payload = service.releaseManualOverride.mock.calls[0][0];
      expect(payload.adminId).toBe('real-admin');
      expect(payload.ipAddress).toBe('203.0.113.9');
    });
  });
});
