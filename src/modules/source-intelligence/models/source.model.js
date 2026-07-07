'use strict';

/**
 * src/modules/source-intelligence/models/source.model.js
 *
 * WP-P2-01 — Source Intelligence Management (SIM)
 *
 * Domain model for the SIM subsystem: the authoritative registry of every
 * external knowledge source consumed by HireRise.
 *
 * SIM owns metadata + governance ONLY. It does not collect, transform, or
 * publish knowledge — those responsibilities belong to COM / EDF / the Data
 * Feed App / Canonical Knowledge Publishing, all downstream of SIM.
 *
 * This file is intentionally the single source of truth for:
 *   - table names
 *   - enums (source type, status, health, collection method, ...)
 *   - row shaping (camelCase <-> snake_case) for the SIM tables
 *
 * Nothing here touches HKP, Knowledge Runtime, or any frozen runtime
 * component. SIM is upstream of all of them.
 */

// ─────────────────────────────────────────────────────────────
// Table Names
// ─────────────────────────────────────────────────────────────

const TABLES = Object.freeze({
  SOURCES: 'sim_sources',
  SOURCE_HEALTH_SNAPSHOTS: 'sim_source_health_snapshots',
  SOURCE_AUDIT_LOG: 'sim_source_audit_log',
  // Enterprise Enhancement 8 — relational, not a JSON blob on sim_sources,
  // so referential integrity + bidirectional lookups are possible.
  SOURCE_RELATIONSHIPS: 'sim_source_relationships',
});

// ─────────────────────────────────────────────────────────────
// Source Categories (top-level) — SOURCE TYPES from WP-P2-01
// ─────────────────────────────────────────────────────────────

const SOURCE_TYPES = Object.freeze({
  GOVERNMENT_API: 'government_api',
  GOVERNMENT_WEBSITE: 'government_website',
  UNIVERSITY_WEBSITE: 'university_website',
  UNIVERSITY_API: 'university_api',
  INDUSTRY_BODY: 'industry_body',
  PROFESSIONAL_COUNCIL: 'professional_council',
  SKILL_PLATFORM: 'skill_platform',
  CERTIFICATION_PROVIDER: 'certification_provider',
  LABOUR_MARKET_SOURCE: 'labour_market_source',
  SALARY_SOURCE: 'salary_source',
  OCCUPATION_DATABASE: 'occupation_database',
  FUTURE_SKILLS_SOURCE: 'future_skills_source',
  RESEARCH_PUBLICATION: 'research_publication',
  INTERNAL_KNOWLEDGE_SOURCE: 'internal_knowledge_source',
  PARTNER_API: 'partner_api',
  MANUAL_SOURCE: 'manual_source',
  CSV_SOURCE: 'csv_source',
  EXCEL_SOURCE: 'excel_source',
  PDF_SOURCE: 'pdf_source',
  JSON_SOURCE: 'json_source',
  XML_SOURCE: 'xml_source',
  RSS_SOURCE: 'rss_source',
});

const SOURCE_TYPE_SET = new Set(Object.values(SOURCE_TYPES));

// ─────────────────────────────────────────────────────────────
// Source Lifecycle / Governance Status
// ─────────────────────────────────────────────────────────────

const SOURCE_STATUS = Object.freeze({
  PENDING_APPROVAL: 'pending_approval',
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  REVIEW_REQUIRED: 'review_required',
  DEPRECATED: 'deprecated',
  BLOCKED: 'blocked',
  ARCHIVED: 'archived',
});

const SOURCE_STATUS_SET = new Set(Object.values(SOURCE_STATUS));

/**
 * Legal status transitions. Enforced by sourceGovernance.service.js.
 * Keeps the lifecycle model explicit and auditable rather than allowing
 * arbitrary status writes from the API surface.
 */
const ALLOWED_STATUS_TRANSITIONS = Object.freeze({
  [SOURCE_STATUS.PENDING_APPROVAL]: [
    SOURCE_STATUS.ACTIVE,
    SOURCE_STATUS.REVIEW_REQUIRED,
    SOURCE_STATUS.BLOCKED,
    SOURCE_STATUS.ARCHIVED,
  ],
  [SOURCE_STATUS.ACTIVE]: [
    SOURCE_STATUS.INACTIVE,
    SOURCE_STATUS.REVIEW_REQUIRED,
    SOURCE_STATUS.DEPRECATED,
    SOURCE_STATUS.BLOCKED,
  ],
  [SOURCE_STATUS.INACTIVE]: [
    SOURCE_STATUS.ACTIVE,
    SOURCE_STATUS.DEPRECATED,
    SOURCE_STATUS.ARCHIVED,
  ],
  [SOURCE_STATUS.REVIEW_REQUIRED]: [
    SOURCE_STATUS.ACTIVE,
    SOURCE_STATUS.INACTIVE,
    SOURCE_STATUS.BLOCKED,
    SOURCE_STATUS.DEPRECATED,
  ],
  [SOURCE_STATUS.DEPRECATED]: [SOURCE_STATUS.ARCHIVED, SOURCE_STATUS.BLOCKED],
  [SOURCE_STATUS.BLOCKED]: [
    SOURCE_STATUS.REVIEW_REQUIRED,
    SOURCE_STATUS.ARCHIVED,
  ],
  [SOURCE_STATUS.ARCHIVED]: [],
});

// ─────────────────────────────────────────────────────────────
// Approval Status (governance workflow, distinct from lifecycle status)
// ─────────────────────────────────────────────────────────────

const APPROVAL_STATUS = Object.freeze({
  NOT_SUBMITTED: 'not_submitted',
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
});

// ─────────────────────────────────────────────────────────────
// Health Status
// ─────────────────────────────────────────────────────────────

const HEALTH_STATUS = Object.freeze({
  UNKNOWN: 'unknown',
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  UNHEALTHY: 'unhealthy',
});

// ─────────────────────────────────────────────────────────────
// Collection Strategy Metadata
// ─────────────────────────────────────────────────────────────

const COLLECTION_METHODS = Object.freeze({
  API_PULL: 'api_pull',
  WEB_SCRAPE: 'web_scrape',
  MANUAL_UPLOAD: 'manual_upload',
  FILE_WATCH: 'file_watch',
  PARTNER_PUSH: 'partner_push',
  RSS_POLL: 'rss_poll',
  EMAIL_INGEST: 'email_ingest',
});

const AUTHENTICATION_METHODS = Object.freeze({
  NONE: 'none',
  API_KEY: 'api_key',
  OAUTH2: 'oauth2',
  BASIC_AUTH: 'basic_auth',
  BEARER_TOKEN: 'bearer_token',
  CERTIFICATE: 'certificate',
  MANUAL: 'manual',
});

const UPDATE_FREQUENCIES = Object.freeze({
  REALTIME: 'realtime',
  HOURLY: 'hourly',
  DAILY: 'daily',
  WEEKLY: 'weekly',
  MONTHLY: 'monthly',
  QUARTERLY: 'quarterly',
  ANNUAL: 'annual',
  AD_HOC: 'ad_hoc',
});

const PRIORITY_LEVELS = Object.freeze({
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
});

// ─────────────────────────────────────────────────────────────
// Enterprise Enhancement 1 — Source Capability Profile
//
// Metadata only. SIM does not enforce or exercise these capabilities;
// COM reads them later to decide how to schedule/collect from a source.
// ─────────────────────────────────────────────────────────────

const SOURCE_CAPABILITIES = Object.freeze({
  INCREMENTAL_SYNC: 'incremental_sync',
  FULL_SYNC: 'full_sync',
  SEARCH_API: 'search_api',
  BULK_EXPORT: 'bulk_export',
  PAGINATION: 'pagination',
  WEBHOOKS: 'webhooks',
  ATTACHMENTS: 'attachments',
  OAUTH: 'oauth',
  ANONYMOUS_ACCESS: 'anonymous_access',
  RATE_LIMITS: 'rate_limits',
  DELTA_SUPPORT: 'delta_support',
  SNAPSHOT_SUPPORT: 'snapshot_support',
});

const SOURCE_CAPABILITY_SET = new Set(Object.values(SOURCE_CAPABILITIES));

// ─────────────────────────────────────────────────────────────
// Enterprise Enhancement 2 — Knowledge Domain Classification
// A source may serve multiple knowledge domains.
// ─────────────────────────────────────────────────────────────

const KNOWLEDGE_DOMAINS = Object.freeze({
  INSTITUTION: 'institution',
  OCCUPATION: 'occupation',
  COURSE: 'course',
  SCHOLARSHIP: 'scholarship',
  SKILL: 'skill',
  EMPLOYER: 'employer',
  SALARY: 'salary',
  CERTIFICATION: 'certification',
  ADMISSION: 'admission',
  LABOUR_MARKET: 'labour_market',
  FUTURE_SKILLS: 'future_skills',
  GOVERNMENT_POLICY: 'government_policy',
  CAREER_OUTCOME: 'career_outcome',
});

const KNOWLEDGE_DOMAIN_SET = new Set(Object.values(KNOWLEDGE_DOMAINS));

// ─────────────────────────────────────────────────────────────
// Enterprise Enhancement 3 — Canonical Entity Coverage
// Which canonical (published) entities a source contributes to.
// ─────────────────────────────────────────────────────────────

const CANONICAL_ENTITIES = Object.freeze({
  INSTITUTION: 'institution',
  OCCUPATION: 'occupation',
  SKILL: 'skill',
  SCHOLARSHIP: 'scholarship',
  EMPLOYER: 'employer',
  SALARY_BAND: 'salary_band',
  CERTIFICATION: 'certification',
  ADMISSION_RULE: 'admission_rule',
  INDUSTRY: 'industry',
  CAREER_OUTCOME: 'career_outcome',
});

const CANONICAL_ENTITY_SET = new Set(Object.values(CANONICAL_ENTITIES));

// ─────────────────────────────────────────────────────────────
// Enterprise Enhancement 4 — Data Quality dimensions
// Deliberately independent of trustScore/reliabilityScore: trust is a
// provenance/governance signal, data quality is a measured characteristic
// of the data the source actually produces.
// ─────────────────────────────────────────────────────────────

const DATA_QUALITY_DIMENSIONS = Object.freeze([
  'completeness',
  'accuracy',
  'consistency',
  'timeliness',
  'coverage',
  'freshness',
  'uniqueness',
]);

// ─────────────────────────────────────────────────────────────
// Enterprise Enhancement 5 — Compliance & Licensing Metadata
// Additive alongside the existing `license` / `usageRestrictions` /
// `licensingMetadata` fields, which are preserved as-is for backward
// compatibility. complianceMetadata is the enterprise superset going
// forward; consolidation is flagged as technical debt in the report
// rather than done as a breaking rename here.
// ─────────────────────────────────────────────────────────────

const REDISTRIBUTION_PERMISSIONS = Object.freeze({
  ALLOWED: 'allowed',
  NOT_ALLOWED: 'not_allowed',
  CONDITIONAL: 'conditional',
  UNKNOWN: 'unknown',
});

const PII_PRESENCE_LEVELS = Object.freeze({
  NONE: 'none',
  POSSIBLE: 'possible',
  CONFIRMED: 'confirmed',
});

const ROBOTS_POLICIES = Object.freeze({
  ALLOWED: 'allowed',
  DISALLOWED: 'disallowed',
  PARTIAL: 'partial',
  NOT_APPLICABLE: 'not_applicable',
  UNKNOWN: 'unknown',
});

const COMPLIANCE_METADATA_FIELDS = Object.freeze([
  'licenseVersion',
  'commercialUsage',
  'redistributionPermission',
  'robotsPolicy',
  'termsAccepted',
  'piiPresence',
  'dataRetentionPolicy',
  'complianceNotes',
]);

// ─────────────────────────────────────────────────────────────
// Enterprise Enhancement 6 — Connector Compatibility
// Advertises which EDF connector types a source can be collected with.
// A source may support more than one.
// ─────────────────────────────────────────────────────────────

const CONNECTOR_TYPES = Object.freeze({
  REST: 'rest',
  GRAPHQL: 'graphql',
  SOAP: 'soap',
  RSS: 'rss',
  CSV: 'csv',
  EXCEL: 'excel',
  JSON: 'json',
  XML: 'xml',
  PDF: 'pdf',
  HTML: 'html',
  WEB_SCRAPER: 'web_scraper',
  WEBHOOK: 'webhook',
  MANUAL_UPLOAD: 'manual_upload',
  AI_EXTRACTION: 'ai_extraction',
});

const CONNECTOR_TYPE_SET = new Set(Object.values(CONNECTOR_TYPES));

// ─────────────────────────────────────────────────────────────
// Enterprise Enhancement 7 — Knowledge Freshness Policy
// Extends (does not replace) the existing updateFrequency /
// expectedFreshnessHours fields.
// ─────────────────────────────────────────────────────────────

const EXPIRATION_BEHAVIOURS = Object.freeze({
  FLAG_STALE: 'flag_stale',
  AUTO_DEPRIORITIZE: 'auto_deprioritize',
  AUTO_ARCHIVE: 'auto_archive',
  NONE: 'none',
});

const FRESHNESS_POLICY_FIELDS = Object.freeze([
  'expectedFreshnessHours',
  'freshnessSlaHours',
  'maximumAcceptableAgeHours',
  'refreshPriority',
  'expirationBehaviour',
]);

// ─────────────────────────────────────────────────────────────
// Enterprise Enhancement 8 — Source Relationship Model
// Directed edges between two sources, stored in their own table
// (sim_source_relationships) rather than as an array column, so
// referential integrity and "what points at me" queries are possible.
// ─────────────────────────────────────────────────────────────

const SOURCE_RELATIONSHIP_TYPES = Object.freeze({
  PARENT: 'parent',
  CHILD: 'child',
  MIRROR: 'mirror',
  BACKUP: 'backup',
  DEPENDS_ON: 'depends_on',
  SUCCESSOR: 'successor',
  REPLACES: 'replaces',
  ALTERNATIVE: 'alternative',
});

const SOURCE_RELATIONSHIP_TYPE_SET = new Set(Object.values(SOURCE_RELATIONSHIP_TYPES));

/**
 * Inverse relationship, used so a relationship written from one direction
 * is queryable/understandable from the other side without requiring the
 * caller to write both rows. parent/child, successor/replaces-style pairs
 * are directional; symmetric types point back at themselves. depends_on
 * has no clean inverse noun in the enum, so callers query it via
 * related_source_id instead.
 */
const INVERSE_RELATIONSHIP_TYPE = Object.freeze({
  [SOURCE_RELATIONSHIP_TYPES.PARENT]: SOURCE_RELATIONSHIP_TYPES.CHILD,
  [SOURCE_RELATIONSHIP_TYPES.CHILD]: SOURCE_RELATIONSHIP_TYPES.PARENT,
  [SOURCE_RELATIONSHIP_TYPES.MIRROR]: SOURCE_RELATIONSHIP_TYPES.MIRROR,
  [SOURCE_RELATIONSHIP_TYPES.BACKUP]: SOURCE_RELATIONSHIP_TYPES.BACKUP,
  [SOURCE_RELATIONSHIP_TYPES.DEPENDS_ON]: null,
  [SOURCE_RELATIONSHIP_TYPES.SUCCESSOR]: SOURCE_RELATIONSHIP_TYPES.REPLACES,
  [SOURCE_RELATIONSHIP_TYPES.REPLACES]: SOURCE_RELATIONSHIP_TYPES.SUCCESSOR,
  [SOURCE_RELATIONSHIP_TYPES.ALTERNATIVE]: SOURCE_RELATIONSHIP_TYPES.ALTERNATIVE,
});

// ─────────────────────────────────────────────────────────────
// Field Allowlists (defense-in-depth: repositories only persist
// fields the domain model recognizes)
// ─────────────────────────────────────────────────────────────

const SOURCE_METADATA_FIELDS = Object.freeze([
  'displayName',
  'description',
  'category',
  'subcategory',
  'owner',
  'maintainer',
  'country',
  'region',
  'coverage',
  'language',
  'sourceType',
  'authenticationMethod',
  'apiEndpoint',
  'website',
  'license',
  'usageRestrictions',
  'updateFrequency',
  'expectedFreshnessHours',
  'collectionMethod',
  'preferredConnector',
  'priority',
  'tags',
  'notes',
  'authMetadata',
  'licensingMetadata',
  'monitoringConfig',
  'governanceMetadata',

  // Enterprise Enhancement 1 — Source Capability Profile
  'capabilityProfile',

  // Enterprise Enhancement 2 — Knowledge Domain Classification
  'knowledgeDomains',

  // Enterprise Enhancement 3 — Canonical Entity Coverage
  'canonicalEntityCoverage',

  // Enterprise Enhancement 4 — Data Quality Profile (independent of trust)
  'dataQualityProfile',

  // Enterprise Enhancement 5 — Compliance & Licensing Metadata
  'complianceMetadata',

  // Enterprise Enhancement 6 — Connector Compatibility
  'connectorCompatibility',

  // Enterprise Enhancement 7 — Knowledge Freshness Policy
  'freshnessPolicy',
]);

const SOURCE_SYSTEM_FIELDS = Object.freeze([
  'trustScore',
  'reliabilityScore',
  'status',
  'approvalStatus',
  'approvedBy',
  'approvedAt',
  'healthStatus',
]);

// ─────────────────────────────────────────────────────────────
// Sanitizers
// ─────────────────────────────────────────────────────────────

/**
 * Keeps only known, writable metadata fields from a create/update payload.
 * Prevents callers from smuggling system-managed fields (trustScore,
 * status, etc.) through the public metadata surface.
 */
function sanitizeSourceMetadataPatch(fields = {}) {
  const out = {};

  for (const key of SOURCE_METADATA_FIELDS) {
    if (fields[key] !== undefined) {
      out[key] = fields[key];
    }
  }

  return out;
}

/**
 * Fields that only governance/admin flows may set directly.
 */
function sanitizeSourceSystemPatch(fields = {}) {
  const out = {};

  for (const key of SOURCE_SYSTEM_FIELDS) {
    if (fields[key] !== undefined) {
      out[key] = fields[key];
    }
  }

  return out;
}

function isValidSourceType(value) {
  return SOURCE_TYPE_SET.has(value);
}

function isValidSourceStatus(value) {
  return SOURCE_STATUS_SET.has(value);
}

function canTransitionStatus(fromStatus, toStatus) {
  if (fromStatus === toStatus) return true;
  const allowed = ALLOWED_STATUS_TRANSITIONS[fromStatus] || [];
  return allowed.includes(toStatus);
}

// ─────────────────────────────────────────────────────────────
// Enterprise enum validators — mirror isValidSourceType/isValidSourceStatus
// above so the validator layer and services can check membership without
// duplicating the Set construction.
// ─────────────────────────────────────────────────────────────

function isValidCapability(value) {
  return SOURCE_CAPABILITY_SET.has(value);
}

function isValidKnowledgeDomain(value) {
  return KNOWLEDGE_DOMAIN_SET.has(value);
}

function isValidCanonicalEntity(value) {
  return CANONICAL_ENTITY_SET.has(value);
}

function isValidConnectorType(value) {
  return CONNECTOR_TYPE_SET.has(value);
}

function isValidRelationshipType(value) {
  return SOURCE_RELATIONSHIP_TYPE_SET.has(value);
}

/**
 * Validates a capabilityProfile payload: an object keyed by capability
 * name with boolean values. Unknown keys are rejected rather than
 * silently dropped, since this is enterprise-facing metadata that COM
 * will rely on — a silently-ignored typo (e.g. "webhook" instead of
 * "webhooks") is worse than a loud rejection at write time.
 */
function isValidCapabilityProfile(profile) {
  if (profile == null) return true;
  if (typeof profile !== 'object' || Array.isArray(profile)) return false;

  return Object.entries(profile).every(
    ([key, value]) => isValidCapability(key) && typeof value === 'boolean'
  );
}

function isValidDomainList(domains) {
  if (domains == null) return true;
  return Array.isArray(domains) && domains.every(isValidKnowledgeDomain);
}

function isValidEntityList(entities) {
  if (entities == null) return true;
  return Array.isArray(entities) && entities.every(isValidCanonicalEntity);
}

function isValidConnectorList(connectors) {
  if (connectors == null) return true;
  return Array.isArray(connectors) && connectors.every(isValidConnectorType);
}

/**
 * Validates a dataQualityProfile payload: an object keyed by one of the
 * seven quality dimensions, each a 0-100 numeric score. Partial profiles
 * are fine (not every source will have every dimension measured yet).
 */
function isValidDataQualityProfile(profile) {
  if (profile == null) return true;
  if (typeof profile !== 'object' || Array.isArray(profile)) return false;

  return Object.entries(profile).every(([key, value]) => {
    if (!DATA_QUALITY_DIMENSIONS.includes(key)) return false;
    return typeof value === 'number' && value >= 0 && value <= 100;
  });
}

function isValidComplianceMetadata(metadata) {
  if (metadata == null) return true;
  if (typeof metadata !== 'object' || Array.isArray(metadata)) return false;

  if (!Object.keys(metadata).every((key) => COMPLIANCE_METADATA_FIELDS.includes(key))) {
    return false;
  }

  if (
    metadata.redistributionPermission !== undefined &&
    !Object.values(REDISTRIBUTION_PERMISSIONS).includes(metadata.redistributionPermission)
  ) {
    return false;
  }

  if (
    metadata.piiPresence !== undefined &&
    !Object.values(PII_PRESENCE_LEVELS).includes(metadata.piiPresence)
  ) {
    return false;
  }

  if (
    metadata.robotsPolicy !== undefined &&
    !Object.values(ROBOTS_POLICIES).includes(metadata.robotsPolicy)
  ) {
    return false;
  }

  if (metadata.commercialUsage !== undefined && typeof metadata.commercialUsage !== 'boolean') {
    return false;
  }

  if (metadata.termsAccepted !== undefined && typeof metadata.termsAccepted !== 'boolean') {
    return false;
  }

  return true;
}

function isValidFreshnessPolicy(policy) {
  if (policy == null) return true;
  if (typeof policy !== 'object' || Array.isArray(policy)) return false;

  if (!Object.keys(policy).every((key) => FRESHNESS_POLICY_FIELDS.includes(key))) {
    return false;
  }

  for (const hourField of [
    'expectedFreshnessHours',
    'freshnessSlaHours',
    'maximumAcceptableAgeHours',
  ]) {
    if (policy[hourField] !== undefined) {
      if (typeof policy[hourField] !== 'number' || policy[hourField] < 0) return false;
    }
  }

  if (
    policy.refreshPriority !== undefined &&
    !Object.values(PRIORITY_LEVELS).includes(policy.refreshPriority)
  ) {
    return false;
  }

  if (
    policy.expirationBehaviour !== undefined &&
    !Object.values(EXPIRATION_BEHAVIOURS).includes(policy.expirationBehaviour)
  ) {
    return false;
  }

  return true;
}

module.exports = {
  TABLES,
  SOURCE_TYPES,
  SOURCE_TYPE_SET,
  SOURCE_STATUS,
  SOURCE_STATUS_SET,
  ALLOWED_STATUS_TRANSITIONS,
  APPROVAL_STATUS,
  HEALTH_STATUS,
  COLLECTION_METHODS,
  AUTHENTICATION_METHODS,
  UPDATE_FREQUENCIES,
  PRIORITY_LEVELS,
  SOURCE_METADATA_FIELDS,
  SOURCE_SYSTEM_FIELDS,
  sanitizeSourceMetadataPatch,
  sanitizeSourceSystemPatch,
  isValidSourceType,
  isValidSourceStatus,
  canTransitionStatus,

  // Enterprise Enhancement 1 — Capability Profile
  SOURCE_CAPABILITIES,
  SOURCE_CAPABILITY_SET,
  isValidCapability,
  isValidCapabilityProfile,

  // Enterprise Enhancement 2 — Knowledge Domain Classification
  KNOWLEDGE_DOMAINS,
  KNOWLEDGE_DOMAIN_SET,
  isValidKnowledgeDomain,
  isValidDomainList,

  // Enterprise Enhancement 3 — Canonical Entity Coverage
  CANONICAL_ENTITIES,
  CANONICAL_ENTITY_SET,
  isValidCanonicalEntity,
  isValidEntityList,

  // Enterprise Enhancement 4 — Data Quality Profile
  DATA_QUALITY_DIMENSIONS,
  isValidDataQualityProfile,

  // Enterprise Enhancement 5 — Compliance & Licensing Metadata
  REDISTRIBUTION_PERMISSIONS,
  PII_PRESENCE_LEVELS,
  ROBOTS_POLICIES,
  COMPLIANCE_METADATA_FIELDS,
  isValidComplianceMetadata,

  // Enterprise Enhancement 6 — Connector Compatibility
  CONNECTOR_TYPES,
  CONNECTOR_TYPE_SET,
  isValidConnectorType,
  isValidConnectorList,

  // Enterprise Enhancement 7 — Knowledge Freshness Policy
  EXPIRATION_BEHAVIOURS,
  FRESHNESS_POLICY_FIELDS,
  isValidFreshnessPolicy,

  // Enterprise Enhancement 8 — Source Relationship Model
  SOURCE_RELATIONSHIP_TYPES,
  SOURCE_RELATIONSHIP_TYPE_SET,
  INVERSE_RELATIONSHIP_TYPE,
  isValidRelationshipType,
};
