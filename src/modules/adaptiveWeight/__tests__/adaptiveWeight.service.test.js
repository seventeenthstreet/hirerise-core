'use strict';

/**
 * adaptiveWeight.service.test.js — WP-ADMIN-COMP-AW-03 §20
 */

const mockLogAdminAction = jest.fn().mockResolvedValue(undefined);

jest.mock('../../../utils/adminAuditLogger', () => ({
  logAdminAction: (...args) => mockLogAdminAction(...args),
}));

const AdaptiveWeightService = require('../adaptiveWeight.service');

function makeRepo(overrides = {}) {
  return {
    getWeights: jest.fn(),
    recordOutcome: jest.fn(),
    applyOverride: jest.fn(),
    releaseOverride: jest.fn(),
    ...overrides,
  };
}

const VALID_KEY = {
  roleFamily: 'engineering',
  experienceBucket: '3-5',
  industryTag: 'fintech',
};

const VALID_WEIGHTS = {
  skills: 0.4,
  experience: 0.25,
  education: 0.15,
  projects: 0.2,
};

describe('AdaptiveWeightService — WP-ADMIN-COMP-AW-03', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getWeightsForScoring()', () => {
    it('validates before calling the repository', async () => {
      const repo = makeRepo();
      const service = new AdaptiveWeightService({ adaptiveWeightRepo: repo });

      await expect(
        service.getWeightsForScoring({ roleFamily: '', experienceBucket: 'bogus', industryTag: '' })
      ).rejects.toMatchObject({ name: 'AdaptiveWeightValidationError' });

      expect(repo.getWeights).not.toHaveBeenCalled();
    });

    it('calls repository getWeights() (never findByKey) and maps the RPC response directly', async () => {
      const rpcResponse = { weights: { skills: 0.4 }, source: 'adaptive', meta: { confidenceScore: 0.7 } };
      const repo = makeRepo({ getWeights: jest.fn().mockResolvedValue(rpcResponse) });
      const service = new AdaptiveWeightService({ adaptiveWeightRepo: repo });

      const result = await service.getWeightsForScoring({ ...VALID_KEY, requestId: 'req-1' });

      expect(repo.getWeights).toHaveBeenCalledTimes(1);
      expect(repo.findByKey).toBeUndefined();
      expect(result).toEqual(rpcResponse);
    });

    it('returns a default response on repository/RPC failure rather than throwing', async () => {
      const repo = makeRepo({ getWeights: jest.fn().mockRejectedValue(new Error('rpc down')) });
      const service = new AdaptiveWeightService({ adaptiveWeightRepo: repo });

      const result = await service.getWeightsForScoring({ ...VALID_KEY });

      expect(result.source).toBe('default');
      expect(result.meta).toEqual({ reason: 'service_error' });
    });
  });

  describe('recordOutcome()', () => {
    it('validates before calling the repository', async () => {
      const repo = makeRepo();
      const service = new AdaptiveWeightService({ adaptiveWeightRepo: repo });

      await expect(
        service.recordOutcome({ ...VALID_KEY, predictedScore: -5, actualOutcome: 1 })
      ).rejects.toMatchObject({ name: 'AdaptiveWeightValidationError' });

      expect(repo.recordOutcome).not.toHaveBeenCalled();
    });

    it('calls repository recordOutcome() exactly once', async () => {
      const repo = makeRepo({
        recordOutcome: jest.fn().mockResolvedValue({
          updated: true,
          weights: VALID_WEIGHTS,
          performanceScore: 0.55,
          confidenceScore: 0.52,
        }),
      });
      const service = new AdaptiveWeightService({ adaptiveWeightRepo: repo });

      await service.recordOutcome({ ...VALID_KEY, predictedScore: 70, actualOutcome: 1, requestId: 'req-2' });

      expect(repo.recordOutcome).toHaveBeenCalledTimes(1);
    });

    it('maps the RPC response onto the compatible {updated, newWeights, performanceScore, confidenceScore} contract', async () => {
      const repo = makeRepo({
        recordOutcome: jest.fn().mockResolvedValue({
          updated: true,
          weights: VALID_WEIGHTS,
          performanceScore: 0.55,
          confidenceScore: 0.52,
        }),
      });
      const service = new AdaptiveWeightService({ adaptiveWeightRepo: repo });

      const result = await service.recordOutcome({ ...VALID_KEY, predictedScore: 70, actualOutcome: 1 });

      expect(result).toEqual({
        updated: true,
        newWeights: VALID_WEIGHTS,
        performanceScore: 0.55,
        confidenceScore: 0.52,
      });
    });

    it('maps the frozen-segment {updated:false} RPC response without fabricating missing fields', async () => {
      const repo = makeRepo({ recordOutcome: jest.fn().mockResolvedValue({ updated: false }) });
      const service = new AdaptiveWeightService({ adaptiveWeightRepo: repo });

      const result = await service.recordOutcome({ ...VALID_KEY, predictedScore: 70, actualOutcome: 1 });

      expect(result).toEqual({
        updated: false,
        newWeights: null,
        performanceScore: null,
        confidenceScore: null,
      });
    });

    it('propagates repository/RPC failures to the caller', async () => {
      const repo = makeRepo({ recordOutcome: jest.fn().mockRejectedValue(new Error('rpc down')) });
      const service = new AdaptiveWeightService({ adaptiveWeightRepo: repo });

      await expect(
        service.recordOutcome({ ...VALID_KEY, predictedScore: 70, actualOutcome: 1 })
      ).rejects.toThrow('rpc down');
    });
  });

  describe('applyManualOverride()', () => {
    it('validates before calling the repository', async () => {
      const repo = makeRepo();
      const service = new AdaptiveWeightService({ adaptiveWeightRepo: repo });

      await expect(
        service.applyManualOverride({ ...VALID_KEY, weights: { skills: 999, experience: 0.25, education: 0.15, projects: 0.2 } })
      ).rejects.toMatchObject({ name: 'AdaptiveWeightValidationError' });

      expect(repo.applyOverride).not.toHaveBeenCalled();
    });

    it('calls repository applyOverride()', async () => {
      const repo = makeRepo({
        applyOverride: jest.fn().mockResolvedValue({ weights: VALID_WEIGHTS, manualOverride: true, freezeLearning: true }),
      });
      const service = new AdaptiveWeightService({ adaptiveWeightRepo: repo });

      await service.applyManualOverride({ ...VALID_KEY, weights: VALID_WEIGHTS, adminId: 'admin-1', ipAddress: '203.0.113.9' });

      expect(repo.applyOverride).toHaveBeenCalledTimes(1);
    });

    it('writes an audit entry only after successful persistence, with the authenticated admin ID', async () => {
      const repo = makeRepo({
        applyOverride: jest.fn().mockResolvedValue({ weights: VALID_WEIGHTS, manualOverride: true, freezeLearning: true }),
      });
      const service = new AdaptiveWeightService({ adaptiveWeightRepo: repo });

      await service.applyManualOverride({ ...VALID_KEY, weights: VALID_WEIGHTS, adminId: 'admin-1', ipAddress: '203.0.113.9' });

      expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
      expect(mockLogAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          adminId: 'admin-1',
          action: 'ADAPTIVE_WEIGHT_OVERRIDE_APPLY',
          entityType: 'adaptive_weight',
          entityId: 'engineering::3-5::fintech',
          ipAddress: '203.0.113.9',
        })
      );
    });

    it('does not write an audit entry when persistence fails', async () => {
      const repo = makeRepo({ applyOverride: jest.fn().mockRejectedValue(new Error('rpc down')) });
      const service = new AdaptiveWeightService({ adaptiveWeightRepo: repo });

      await expect(
        service.applyManualOverride({ ...VALID_KEY, weights: VALID_WEIGHTS, adminId: 'admin-1' })
      ).rejects.toThrow('rpc down');

      expect(mockLogAdminAction).not.toHaveBeenCalled();
    });

    it('a rejected audit write does not change the successful response', async () => {
      mockLogAdminAction.mockRejectedValueOnce(new Error('audit db down'));
      const repo = makeRepo({
        applyOverride: jest.fn().mockResolvedValue({ weights: VALID_WEIGHTS, manualOverride: true, freezeLearning: true }),
      });
      const service = new AdaptiveWeightService({ adaptiveWeightRepo: repo });

      const result = await service.applyManualOverride({ ...VALID_KEY, weights: VALID_WEIGHTS, adminId: 'admin-1' });

      expect(result).toEqual({ weights: VALID_WEIGHTS, manualOverride: true });
    });

    it('returns the controller-compatible {weights, manualOverride:true} contract', async () => {
      const repo = makeRepo({
        applyOverride: jest.fn().mockResolvedValue({ weights: VALID_WEIGHTS, manualOverride: true, freezeLearning: true }),
      });
      const service = new AdaptiveWeightService({ adaptiveWeightRepo: repo });

      const result = await service.applyManualOverride({ ...VALID_KEY, weights: VALID_WEIGHTS, adminId: 'admin-1' });

      expect(result).toEqual({ weights: VALID_WEIGHTS, manualOverride: true });
    });
  });

  describe('releaseManualOverride()', () => {
    it('calls repository releaseOverride()', async () => {
      const repo = makeRepo({ releaseOverride: jest.fn().mockResolvedValue({ released: true }) });
      const service = new AdaptiveWeightService({ adaptiveWeightRepo: repo });

      await service.releaseManualOverride({ ...VALID_KEY, adminId: 'admin-1', ipAddress: '203.0.113.9' });

      expect(repo.releaseOverride).toHaveBeenCalledTimes(1);
    });

    it('writes an audit entry after successful persistence', async () => {
      const repo = makeRepo({ releaseOverride: jest.fn().mockResolvedValue({ released: true }) });
      const service = new AdaptiveWeightService({ adaptiveWeightRepo: repo });

      await service.releaseManualOverride({ ...VALID_KEY, adminId: 'admin-1', ipAddress: '203.0.113.9' });

      expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
      expect(mockLogAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          adminId: 'admin-1',
          action: 'ADAPTIVE_WEIGHT_OVERRIDE_RELEASE',
          entityType: 'adaptive_weight',
          entityId: 'engineering::3-5::fintech',
          ipAddress: '203.0.113.9',
        })
      );
    });

    it('a rejected audit write does not change the successful response', async () => {
      mockLogAdminAction.mockRejectedValueOnce(new Error('audit db down'));
      const repo = makeRepo({ releaseOverride: jest.fn().mockResolvedValue({ released: true }) });
      const service = new AdaptiveWeightService({ adaptiveWeightRepo: repo });

      const result = await service.releaseManualOverride({ ...VALID_KEY, adminId: 'admin-1' });

      expect(result).toEqual({ released: true });
    });

    it('propagates repository/RPC failures to the caller', async () => {
      const repo = makeRepo({ releaseOverride: jest.fn().mockRejectedValue(new Error('rpc down')) });
      const service = new AdaptiveWeightService({ adaptiveWeightRepo: repo });

      await expect(
        service.releaseManualOverride({ ...VALID_KEY, adminId: 'admin-1' })
      ).rejects.toThrow('rpc down');
    });

    it('does not write an audit entry for a nonexistent segment (released: false)', async () => {
      // WP-ADMIN-COMP-AW-03A corrective fix: release_adaptive_override() returns
      // { released: false } as a safe no-op when the segment doesn't exist. No row
      // was mutated, so no ADAPTIVE_WEIGHT_OVERRIDE_RELEASE audit entry should be
      // written for it.
      const repo = makeRepo({ releaseOverride: jest.fn().mockResolvedValue({ released: false }) });
      const service = new AdaptiveWeightService({ adaptiveWeightRepo: repo });

      const result = await service.releaseManualOverride({ ...VALID_KEY, adminId: 'admin-1', ipAddress: '203.0.113.9' });

      expect(result).toEqual({ released: false });
      expect(mockLogAdminAction).not.toHaveBeenCalled();
    });
  });
});
