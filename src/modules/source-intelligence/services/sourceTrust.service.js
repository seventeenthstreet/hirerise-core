'use strict';

/**
 * src/modules/source-intelligence/services/sourceTrust.service.js
 *
 * Trust Model (deliverable #9).
 *
 * Trust score is a governance/provenance signal: how much should the
 * knowledge pipeline weight this source, independent of whether it is
 * currently *reachable* (that's reliability / health, computed in
 * sourceHealth.service.js from observed uptime).
 *
 * Deliberately simple, deterministic, and fully explainable — this is
 * metadata governance, not ML. Downstream consumers (COM, Knowledge QA)
 * can rely on the score being reproducible from the source's own
 * declared metadata plus its reliability trend.
 */

const {
  SOURCE_TYPES,
  AUTHENTICATION_METHODS,
} = require('../models/source.model');

// Category-level base trust weights. Government / accredited institutional
// sources start higher; manual/free-text sources start lower until vetted.
const BASE_TRUST_BY_SOURCE_TYPE = Object.freeze({
  [SOURCE_TYPES.GOVERNMENT_API]: 95,
  [SOURCE_TYPES.GOVERNMENT_WEBSITE]: 85,
  [SOURCE_TYPES.UNIVERSITY_API]: 90,
  [SOURCE_TYPES.UNIVERSITY_WEBSITE]: 80,
  [SOURCE_TYPES.PROFESSIONAL_COUNCIL]: 88,
  [SOURCE_TYPES.INDUSTRY_BODY]: 80,
  [SOURCE_TYPES.CERTIFICATION_PROVIDER]: 82,
  [SOURCE_TYPES.OCCUPATION_DATABASE]: 85,
  [SOURCE_TYPES.LABOUR_MARKET_SOURCE]: 78,
  [SOURCE_TYPES.SALARY_SOURCE]: 70,
  [SOURCE_TYPES.RESEARCH_PUBLICATION]: 82,
  [SOURCE_TYPES.FUTURE_SKILLS_SOURCE]: 65,
  [SOURCE_TYPES.SKILL_PLATFORM]: 68,
  [SOURCE_TYPES.INTERNAL_KNOWLEDGE_SOURCE]: 90,
  [SOURCE_TYPES.PARTNER_API]: 72,
  [SOURCE_TYPES.MANUAL_SOURCE]: 50,
  [SOURCE_TYPES.CSV_SOURCE]: 45,
  [SOURCE_TYPES.EXCEL_SOURCE]: 45,
  [SOURCE_TYPES.PDF_SOURCE]: 45,
  [SOURCE_TYPES.JSON_SOURCE]: 55,
  [SOURCE_TYPES.XML_SOURCE]: 55,
  [SOURCE_TYPES.RSS_SOURCE]: 40,
});

const DEFAULT_BASE_TRUST = 50;

const AUTH_TRUST_ADJUSTMENT = Object.freeze({
  [AUTHENTICATION_METHODS.OAUTH2]: 4,
  [AUTHENTICATION_METHODS.API_KEY]: 2,
  [AUTHENTICATION_METHODS.CERTIFICATE]: 4,
  [AUTHENTICATION_METHODS.BEARER_TOKEN]: 2,
  [AUTHENTICATION_METHODS.BASIC_AUTH]: 0,
  [AUTHENTICATION_METHODS.MANUAL]: -3,
  [AUTHENTICATION_METHODS.NONE]: -1,
});

function clamp(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Computes a 0-100 trust score from declared source metadata plus its
 * governance state. Reliability (observed uptime) is blended in
 * separately by sourceRegistry.service so a source that has *never been
 * observed yet* still gets a sensible provenance-based starting score.
 */
function computeBaseTrustScore(source = {}) {
  let score = BASE_TRUST_BY_SOURCE_TYPE[source.sourceType] ?? DEFAULT_BASE_TRUST;

  if (source.authenticationMethod) {
    score += AUTH_TRUST_ADJUSTMENT[source.authenticationMethod] ?? 0;
  }

  if (source.license) score += 3;
  if (source.apiEndpoint) score += 2; // structured access > scraping
  if (!source.apiEndpoint && !source.website) score -= 10;

  return Math.round(clamp(score));
}

/**
 * Blends the declared/base score with an observed reliability score
 * (0-100, from sourceHealth.service) using a governance-first weighting:
 * provenance still dominates, but sustained failures pull trust down.
 */
function blendWithReliability(baseTrustScore, reliabilityScore) {
  if (!Number.isFinite(reliabilityScore)) return baseTrustScore;

  const blended = baseTrustScore * 0.7 + reliabilityScore * 0.3;
  return Math.round(clamp(blended));
}

module.exports = {
  BASE_TRUST_BY_SOURCE_TYPE,
  computeBaseTrustScore,
  blendWithReliability,
};
