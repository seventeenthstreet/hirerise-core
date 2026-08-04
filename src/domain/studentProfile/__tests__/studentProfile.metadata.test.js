'use strict';

/**
 * __tests__/studentProfile.metadata.test.js
 *
 * Unit tests for the Metadata Builder. Pure functions — no mocking needed.
 */

const {
  computeCreatedAt,
  computeUpdatedAt,
  computeSourceSystemProvenance,
} = require('../studentProfile.metadata');
const { SOURCE_SYSTEMS } = require('../studentProfile.constants');

describe('studentProfile.metadata', () => {
  describe('computeCreatedAt', () => {
    it('returns the min() timestamp across all sources', () => {
      const result = computeCreatedAt([
        { createdAt: '2026-03-01T00:00:00.000Z', updatedAt: null },
        { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: null },
        { createdAt: '2026-02-01T00:00:00.000Z', updatedAt: null },
      ]);
      expect(result).toBe('2026-01-01T00:00:00.000Z');
    });

    it('ignores null/undefined entries', () => {
      const result = computeCreatedAt([{ createdAt: null }, { createdAt: '2026-01-01T00:00:00.000Z' }, {}]);
      expect(result).toBe('2026-01-01T00:00:00.000Z');
    });

    it('returns null when no source has a timestamp', () => {
      expect(computeCreatedAt([])).toBeNull();
      expect(computeCreatedAt([{ createdAt: null }])).toBeNull();
      expect(computeCreatedAt(undefined)).toBeNull();
    });
  });

  describe('computeUpdatedAt', () => {
    it('returns the max() timestamp across all sources', () => {
      const result = computeUpdatedAt([
        { updatedAt: '2026-03-01T00:00:00.000Z' },
        { updatedAt: '2026-05-01T00:00:00.000Z' },
        { updatedAt: '2026-02-01T00:00:00.000Z' },
      ]);
      expect(result).toBe('2026-05-01T00:00:00.000Z');
    });

    it('returns null when no source has a timestamp', () => {
      expect(computeUpdatedAt([])).toBeNull();
    });
  });

  describe('computeSourceSystemProvenance', () => {
    it('includes legacy_onboarding only when legacy data exists', () => {
      expect(computeSourceSystemProvenance({ hasLegacyData: true, hasV2Data: false })).toEqual([
        SOURCE_SYSTEMS.LEGACY_ONBOARDING,
      ]);
    });

    it('includes onboarding_v2 only when v2 data exists', () => {
      expect(computeSourceSystemProvenance({ hasLegacyData: false, hasV2Data: true })).toEqual([
        SOURCE_SYSTEMS.ONBOARDING_V2,
      ]);
    });

    it('includes both when both exist, and never includes frontend_direct', () => {
      const result = computeSourceSystemProvenance({ hasLegacyData: true, hasV2Data: true });
      expect(result).toEqual([SOURCE_SYSTEMS.LEGACY_ONBOARDING, SOURCE_SYSTEMS.ONBOARDING_V2]);
      expect(result).not.toContain(SOURCE_SYSTEMS.FRONTEND_DIRECT);
    });

    it('returns an empty array when neither exists', () => {
      expect(computeSourceSystemProvenance({ hasLegacyData: false, hasV2Data: false })).toEqual([]);
    });
  });
});
