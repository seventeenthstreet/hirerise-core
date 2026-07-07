'use strict';

const {
  computeBaseTrustScore,
  blendWithReliability,
} = require('../services/sourceTrust.service');
const { SOURCE_TYPES, AUTHENTICATION_METHODS } = require('../models/source.model');

describe('SIM sourceTrust.service', () => {
  describe('computeBaseTrustScore', () => {
    it('scores a government API higher than an RSS source', () => {
      const govScore = computeBaseTrustScore({
        sourceType: SOURCE_TYPES.GOVERNMENT_API,
        apiEndpoint: 'https://api.gov.example/data',
        authenticationMethod: AUTHENTICATION_METHODS.OAUTH2,
        license: 'Open Government License',
      });

      const rssScore = computeBaseTrustScore({
        sourceType: SOURCE_TYPES.RSS_SOURCE,
      });

      expect(govScore).toBeGreaterThan(rssScore);
    });

    it('penalizes a source with neither an endpoint nor a website', () => {
      const withEndpoint = computeBaseTrustScore({
        sourceType: SOURCE_TYPES.MANUAL_SOURCE,
        apiEndpoint: 'https://example.com/api',
      });
      const withoutAny = computeBaseTrustScore({
        sourceType: SOURCE_TYPES.MANUAL_SOURCE,
      });

      expect(withEndpoint).toBeGreaterThan(withoutAny);
    });

    it('always returns a score clamped to [0, 100]', () => {
      const score = computeBaseTrustScore({ sourceType: 'not_a_real_type' });
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    });

    it('falls back to the default base trust for unrecognized source types', () => {
      const score = computeBaseTrustScore({
        sourceType: 'not_a_real_type',
        apiEndpoint: 'https://example.com',
      });
      // DEFAULT_BASE_TRUST (50) + apiEndpoint bonus (2)
      expect(score).toBe(52);
    });
  });

  describe('blendWithReliability', () => {
    it('returns the base score unchanged when reliability is not a number', () => {
      expect(blendWithReliability(80, null)).toBe(80);
      expect(blendWithReliability(80, undefined)).toBe(80);
    });

    it('pulls the score down when observed reliability is poor', () => {
      const blended = blendWithReliability(90, 10);
      expect(blended).toBeLessThan(90);
      expect(blended).toBe(Math.round(90 * 0.7 + 10 * 0.3));
    });

    it('keeps the score high when observed reliability is strong', () => {
      const blended = blendWithReliability(90, 100);
      expect(blended).toBeGreaterThanOrEqual(90);
    });
  });
});
