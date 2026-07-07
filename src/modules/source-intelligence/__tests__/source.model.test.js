'use strict';

const {
  SOURCE_STATUS,
  canTransitionStatus,
  isValidSourceType,
  isValidSourceStatus,
  sanitizeSourceMetadataPatch,
  sanitizeSourceSystemPatch,
  isValidCapabilityProfile,
  isValidDomainList,
  isValidEntityList,
  isValidDataQualityProfile,
  isValidComplianceMetadata,
  isValidConnectorList,
  isValidFreshnessPolicy,
  isValidRelationshipType,
  INVERSE_RELATIONSHIP_TYPE,
} = require('../models/source.model');

describe('SIM source.model', () => {
  describe('canTransitionStatus', () => {
    it('allows pending_approval -> active', () => {
      expect(
        canTransitionStatus(SOURCE_STATUS.PENDING_APPROVAL, SOURCE_STATUS.ACTIVE)
      ).toBe(true);
    });

    it('allows a status to "transition" to itself (idempotent)', () => {
      expect(canTransitionStatus(SOURCE_STATUS.ACTIVE, SOURCE_STATUS.ACTIVE)).toBe(true);
    });

    it('forbids archived -> active (archived is terminal)', () => {
      expect(canTransitionStatus(SOURCE_STATUS.ARCHIVED, SOURCE_STATUS.ACTIVE)).toBe(false);
    });

    it('forbids skipping straight from pending_approval to archived-then-active', () => {
      expect(
        canTransitionStatus(SOURCE_STATUS.BLOCKED, SOURCE_STATUS.ACTIVE)
      ).toBe(false);
    });

    it('allows blocked -> review_required (path back into governance)', () => {
      expect(
        canTransitionStatus(SOURCE_STATUS.BLOCKED, SOURCE_STATUS.REVIEW_REQUIRED)
      ).toBe(true);
    });
  });

  describe('isValidSourceType / isValidSourceStatus', () => {
    it('accepts a known source type', () => {
      expect(isValidSourceType('government_api')).toBe(true);
    });

    it('rejects an unknown source type', () => {
      expect(isValidSourceType('made_up_type')).toBe(false);
    });

    it('rejects an unknown status', () => {
      expect(isValidSourceStatus('totally_fake')).toBe(false);
    });
  });

  describe('sanitizeSourceMetadataPatch', () => {
    it('keeps only known metadata fields', () => {
      const result = sanitizeSourceMetadataPatch({
        displayName: 'O*NET',
        sourceType: 'occupation_database',
        trustScore: 999, // system field — must be dropped
        status: 'active', // system field — must be dropped
        unknownField: 'nope',
      });

      expect(result).toEqual({
        displayName: 'O*NET',
        sourceType: 'occupation_database',
      });
    });

    it('returns an empty object when nothing recognized is provided', () => {
      expect(sanitizeSourceMetadataPatch({ foo: 'bar' })).toEqual({});
    });
  });

  describe('sanitizeSourceSystemPatch', () => {
    it('keeps only system-managed fields', () => {
      const result = sanitizeSourceSystemPatch({
        trustScore: 80,
        displayName: 'should be dropped',
        status: 'active',
      });

      expect(result).toEqual({ trustScore: 80, status: 'active' });
    });
  });

  describe('Enterprise Enhancement 1 — capability profile', () => {
    it('accepts a boolean map of recognized capabilities', () => {
      expect(isValidCapabilityProfile({ webhooks: true, oauth: false })).toBe(true);
    });

    it('rejects an unrecognized capability key', () => {
      expect(isValidCapabilityProfile({ webhook: true })).toBe(false);
    });

    it('rejects a non-boolean value', () => {
      expect(isValidCapabilityProfile({ webhooks: 'yes' })).toBe(false);
    });

    it('treats null/undefined as valid (field is optional)', () => {
      expect(isValidCapabilityProfile(null)).toBe(true);
      expect(isValidCapabilityProfile(undefined)).toBe(true);
    });
  });

  describe('Enterprise Enhancement 2/3 — domain and entity lists', () => {
    it('accepts a list of recognized knowledge domains', () => {
      expect(isValidDomainList(['skill', 'salary'])).toBe(true);
    });

    it('rejects an unrecognized domain', () => {
      expect(isValidDomainList(['skill', 'not_a_domain'])).toBe(false);
    });

    it('accepts a list of recognized canonical entities', () => {
      expect(isValidEntityList(['salary_band', 'institution'])).toBe(true);
    });

    it('rejects an unrecognized canonical entity', () => {
      expect(isValidEntityList(['not_an_entity'])).toBe(false);
    });
  });

  describe('Enterprise Enhancement 4 — data quality profile', () => {
    it('accepts partial, in-range scores', () => {
      expect(isValidDataQualityProfile({ completeness: 80, accuracy: 95 })).toBe(true);
    });

    it('rejects a score outside 0-100', () => {
      expect(isValidDataQualityProfile({ completeness: 150 })).toBe(false);
    });

    it('rejects an unrecognized dimension', () => {
      expect(isValidDataQualityProfile({ vibes: 100 })).toBe(false);
    });
  });

  describe('Enterprise Enhancement 5 — compliance metadata', () => {
    it('accepts a recognized shape', () => {
      expect(
        isValidComplianceMetadata({ piiPresence: 'none', commercialUsage: true })
      ).toBe(true);
    });

    it('rejects an unrecognized enum value', () => {
      expect(isValidComplianceMetadata({ piiPresence: 'maybe' })).toBe(false);
    });
  });

  describe('Enterprise Enhancement 6 — connector compatibility', () => {
    it('accepts a list of recognized connector types', () => {
      expect(isValidConnectorList(['rest', 'csv'])).toBe(true);
    });

    it('rejects an unrecognized connector type', () => {
      expect(isValidConnectorList(['sftp'])).toBe(false);
    });
  });

  describe('Enterprise Enhancement 7 — freshness policy', () => {
    it('accepts a recognized shape', () => {
      expect(
        isValidFreshnessPolicy({ expectedFreshnessHours: 24, refreshPriority: 'high' })
      ).toBe(true);
    });

    it('rejects an unrecognized refreshPriority', () => {
      expect(isValidFreshnessPolicy({ refreshPriority: 'urgent' })).toBe(false);
    });

    it('rejects a negative hour value', () => {
      expect(isValidFreshnessPolicy({ expectedFreshnessHours: -1 })).toBe(false);
    });
  });

  describe('Enterprise Enhancement 8 — relationship types', () => {
    it('accepts a recognized relationship type', () => {
      expect(isValidRelationshipType('mirror')).toBe(true);
    });

    it('rejects an unrecognized relationship type', () => {
      expect(isValidRelationshipType('cousin')).toBe(false);
    });

    it('defines an inverse for directional relationship types', () => {
      expect(INVERSE_RELATIONSHIP_TYPE.parent).toBe('child');
      expect(INVERSE_RELATIONSHIP_TYPE.successor).toBe('replaces');
    });
  });

  describe('sanitizeSourceMetadataPatch — enterprise fields', () => {
    it('passes through the new enterprise metadata fields', () => {
      const result = sanitizeSourceMetadataPatch({
        knowledgeDomains: ['skill'],
        canonicalEntityCoverage: ['salary_band'],
        capabilityProfile: { webhooks: true },
        dataQualityProfile: { completeness: 90 },
        complianceMetadata: { piiPresence: 'none' },
        connectorCompatibility: ['rest'],
        freshnessPolicy: { refreshPriority: 'high' },
        bogus: 'dropped',
      });

      expect(result).toEqual({
        knowledgeDomains: ['skill'],
        canonicalEntityCoverage: ['salary_band'],
        capabilityProfile: { webhooks: true },
        dataQualityProfile: { completeness: 90 },
        complianceMetadata: { piiPresence: 'none' },
        connectorCompatibility: ['rest'],
        freshnessPolicy: { refreshPriority: 'high' },
      });
    });
  });
});
