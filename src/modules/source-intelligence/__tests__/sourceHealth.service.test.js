'use strict';

const {
  deriveHealthStatus,
  reliabilityScoreFromRollup,
} = require('../services/sourceHealth.service');
const { HEALTH_STATUS } = require('../models/source.model');

describe('SIM sourceHealth.service (pure derivation logic)', () => {
  describe('deriveHealthStatus', () => {
    it('returns UNKNOWN when there is no sample history', () => {
      expect(deriveHealthStatus({ sampleSize: 0, failureCount: 0 })).toBe(
        HEALTH_STATUS.UNKNOWN
      );
      expect(deriveHealthStatus(null)).toBe(HEALTH_STATUS.UNKNOWN);
    });

    it('returns HEALTHY for a low failure rate with enough samples', () => {
      expect(
        deriveHealthStatus({ sampleSize: 10, failureCount: 1, successCount: 9 })
      ).toBe(HEALTH_STATUS.HEALTHY);
    });

    it('returns DEGRADED once failure rate crosses the degraded threshold', () => {
      expect(
        deriveHealthStatus({ sampleSize: 10, failureCount: 3, successCount: 7 })
      ).toBe(HEALTH_STATUS.DEGRADED);
    });

    it('returns UNHEALTHY once failure rate crosses the unhealthy threshold', () => {
      expect(
        deriveHealthStatus({ sampleSize: 10, failureCount: 6, successCount: 4 })
      ).toBe(HEALTH_STATUS.UNHEALTHY);
    });

    it('does not flag DEGRADED on a tiny sample even with one failure', () => {
      // sampleSize below minSampleSizeForDegraded (3) should not trip yet
      expect(
        deriveHealthStatus({ sampleSize: 2, failureCount: 1, successCount: 1 })
      ).toBe(HEALTH_STATUS.HEALTHY);
    });
  });

  describe('reliabilityScoreFromRollup', () => {
    it('returns null when there is no sample history', () => {
      expect(reliabilityScoreFromRollup({ sampleSize: 0 })).toBeNull();
    });

    it('computes a 0-100 percentage of successes', () => {
      expect(
        reliabilityScoreFromRollup({ sampleSize: 4, successCount: 3, failureCount: 1 })
      ).toBe(75);
    });
  });
});
