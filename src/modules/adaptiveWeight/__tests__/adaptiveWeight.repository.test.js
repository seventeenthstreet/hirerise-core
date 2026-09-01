'use strict';

/**
 * adaptiveWeight.repository.test.js — WP-ADMIN-COMP-AW-03 §19
 *
 * Exercises AdaptiveWeightRepository's pure-RPC calls against a minimal
 * fake of the Supabase client's .rpc() method, mirroring the mocking
 * pattern used by adminWeights.repository.test.js.
 */

let mockRpcResult;
let mockRpcError;
let lastRpcCall;

const mockSupabase = {
  rpc: jest.fn((fnName, params) => {
    lastRpcCall = { fnName, params };
    if (mockRpcError) {
      return Promise.resolve({ data: null, error: mockRpcError });
    }
    return Promise.resolve({ data: mockRpcResult, error: null });
  }),
};

jest.mock('../../../config/supabase', () => ({
  get supabase() {
    return mockSupabase;
  },
}));

const AdaptiveWeightRepository = require('../adaptiveWeight.repository');

describe('AdaptiveWeightRepository — WP-ADMIN-COMP-AW-03', () => {
  let repo;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRpcResult = null;
    mockRpcError = null;
    lastRpcCall = null;
    repo = new AdaptiveWeightRepository();
  });

  describe('getWeights()', () => {
    it('calls get_adaptive_weights with the three key parameters', async () => {
      mockRpcResult = { weights: {}, source: 'default', meta: {} };

      await repo.getWeights({
        roleFamily: 'engineering',
        experienceBucket: '3-5',
        industryTag: 'fintech',
        requestId: 'req-1',
      });

      expect(lastRpcCall.fnName).toBe('get_adaptive_weights');
      expect(lastRpcCall.params).toEqual({
        p_role_family: 'engineering',
        p_experience_bucket: '3-5',
        p_industry_tag: 'fintech',
      });
    });

    it('returns the RPC data on success', async () => {
      mockRpcResult = { weights: { skills: 0.4 }, source: 'adaptive', meta: {} };
      const result = await repo.getWeights({
        roleFamily: 'engineering',
        experienceBucket: '3-5',
        industryTag: 'fintech',
      });
      expect(result).toEqual(mockRpcResult);
    });

    it('propagates the RPC error', async () => {
      mockRpcError = { message: 'connection refused' };
      await expect(
        repo.getWeights({ roleFamily: 'a', experienceBucket: 'b', industryTag: 'c' })
      ).rejects.toBeTruthy();
    });
  });

  describe('recordOutcome()', () => {
    it('calls record_adaptive_outcome with all five expected parameters', async () => {
      mockRpcResult = { updated: true };

      await repo.recordOutcome({
        roleFamily: 'engineering',
        experienceBucket: '3-5',
        industryTag: 'fintech',
        predictedScore: 72,
        actualOutcome: 1,
        requestId: 'req-2',
      });

      expect(lastRpcCall.fnName).toBe('record_adaptive_outcome');
      expect(lastRpcCall.params).toEqual({
        p_role_family: 'engineering',
        p_experience_bucket: '3-5',
        p_industry_tag: 'fintech',
        p_predicted_score: 72,
        p_actual_outcome: 1,
      });
    });

    it('returns the RPC data on success', async () => {
      mockRpcResult = { updated: true, weights: { skills: 0.41 }, performanceScore: 0.5, confidenceScore: 0.5 };
      const result = await repo.recordOutcome({
        roleFamily: 'a',
        experienceBucket: 'b',
        industryTag: 'c',
        predictedScore: 50,
        actualOutcome: 0,
      });
      expect(result).toEqual(mockRpcResult);
    });

    it('propagates the RPC error', async () => {
      mockRpcError = { message: 'connection refused' };
      await expect(
        repo.recordOutcome({
          roleFamily: 'a',
          experienceBucket: 'b',
          industryTag: 'c',
          predictedScore: 50,
          actualOutcome: 0,
        })
      ).rejects.toBeTruthy();
    });
  });

  describe('applyOverride()', () => {
    it('calls apply_adaptive_override with all seven expected parameters', async () => {
      mockRpcResult = { weights: {}, manualOverride: true, freezeLearning: true };

      await repo.applyOverride({
        roleFamily: 'engineering',
        experienceBucket: '3-5',
        industryTag: 'fintech',
        weights: { skills: 0.4, experience: 0.25, education: 0.15, projects: 0.2 },
        requestId: 'req-3',
      });

      expect(lastRpcCall.fnName).toBe('apply_adaptive_override');
      expect(lastRpcCall.params).toEqual({
        p_role_family: 'engineering',
        p_experience_bucket: '3-5',
        p_industry_tag: 'fintech',
        p_skills: 0.4,
        p_experience: 0.25,
        p_education: 0.15,
        p_projects: 0.2,
      });
    });

    it('returns the RPC data on success', async () => {
      mockRpcResult = { weights: { skills: 0.4 }, manualOverride: true, freezeLearning: true };
      const result = await repo.applyOverride({
        roleFamily: 'a',
        experienceBucket: 'b',
        industryTag: 'c',
        weights: { skills: 0.4, experience: 0.25, education: 0.15, projects: 0.2 },
      });
      expect(result).toEqual(mockRpcResult);
    });

    it('propagates the RPC error', async () => {
      mockRpcError = { message: 'connection refused' };
      await expect(
        repo.applyOverride({
          roleFamily: 'a',
          experienceBucket: 'b',
          industryTag: 'c',
          weights: { skills: 0.4, experience: 0.25, education: 0.15, projects: 0.2 },
        })
      ).rejects.toBeTruthy();
    });
  });

  describe('releaseOverride()', () => {
    it('calls release_adaptive_override with all three expected parameters', async () => {
      mockRpcResult = { released: true };

      await repo.releaseOverride({
        roleFamily: 'engineering',
        experienceBucket: '3-5',
        industryTag: 'fintech',
        requestId: 'req-4',
      });

      expect(lastRpcCall.fnName).toBe('release_adaptive_override');
      expect(lastRpcCall.params).toEqual({
        p_role_family: 'engineering',
        p_experience_bucket: '3-5',
        p_industry_tag: 'fintech',
      });
    });

    it('returns the RPC data on success', async () => {
      mockRpcResult = { released: true };
      const result = await repo.releaseOverride({
        roleFamily: 'a',
        experienceBucket: 'b',
        industryTag: 'c',
      });
      expect(result).toEqual(mockRpcResult);
    });

    it('propagates the RPC error', async () => {
      mockRpcError = { message: 'connection refused' };
      await expect(
        repo.releaseOverride({ roleFamily: 'a', experienceBucket: 'b', industryTag: 'c' })
      ).rejects.toBeTruthy();
    });
  });
});
