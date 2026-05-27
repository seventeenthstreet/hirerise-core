'use strict';

/**
 * src/modules/student-onboarding/validators/intelligence.validator.js
 *
 * Phase 3D — Cross-Domain Intelligence Layer
 * SIGNAL REGISTRY VALIDATORS
 *
 * PURPOSE:
 *   Validates signal keys, contribution payloads, and aggregation inputs
 *   against the canonical registry (constants/intelligence.js cache).
 *
 *   Two layers of validation:
 *   Layer 1 — Static: validates against the in-memory registry cache.
 *             Fast, synchronous, no DB round-trip. Use at normalizer output.
 *   Layer 2 — Dynamic: validates against the live DB registry.
 *             Async, used by controllers to validate API input.
 *
 * VALIDATION PHILOSOPHY:
 *   Validators return structured result objects — they do NOT throw.
 *   Callers decide whether to abort or continue with warnings.
 *   This supports partial-bundle semantics (invalid signals are dropped, not fatal).
 */

const {
  ALL_SIGNAL_KEYS,
  DEPRECATED_SIGNAL_KEYS,
  SIGNAL_REGISTRY_METADATA,
  INTELLIGENCE_DOMAINS,
  EVIDENCE_SOURCE_TYPES,
  AGGREGATION_VERSION,
  TAXONOMY_VERSION,
} = require('../constants/intelligence');

// ─────────────────────────────────────────────────────────────────────────────
// STATIC VALIDATORS
// Synchronous — use these in normalizers and aggregators.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates a signal key against the static registry cache.
 *
 * @param {string} signalKey
 * @returns {{ valid: boolean, error: string|null, deprecated: boolean }}
 */
function validateSignalKey(signalKey) {
  if (!signalKey || typeof signalKey !== 'string') {
    return { valid: false, error: 'signal_key must be a non-empty string', deprecated: false };
  }

  if (!/^[a-z][a-z0-9_]{1,63}$/.test(signalKey)) {
    return {
      valid:      false,
      error:      `signal_key "${signalKey}" does not match required format (lowercase snake_case, 2–64 chars)`,
      deprecated: false,
    };
  }

  if (DEPRECATED_SIGNAL_KEYS.includes(signalKey)) {
    return {
      valid:      false,
      error:      `signal_key "${signalKey}" is deprecated — no new evidence should be written`,
      deprecated: true,
    };
  }

  if (!ALL_SIGNAL_KEYS.includes(signalKey)) {
    return {
      valid:      false,
      error:      `signal_key "${signalKey}" is not in the v1 signal registry`,
      deprecated: false,
    };
  }

  return { valid: true, error: null, deprecated: false };
}

/**
 * Validates a contribution weight value.
 *
 * @param {unknown} weight
 * @returns {{ valid: boolean, error: string|null }}
 */
function validateContributionWeight(weight) {
  if (weight === null || weight === undefined) {
    return { valid: false, error: 'contribution_weight is required' };
  }

  const num = Number(weight);
  if (Number.isNaN(num)) {
    return { valid: false, error: `contribution_weight must be a number, got: ${typeof weight}` };
  }

  if (num < 0.0 || num > 1.0) {
    return { valid: false, error: `contribution_weight must be in [0,1], got: ${num}` };
  }

  return { valid: true, error: null };
}

/**
 * Validates a single SignalContribution object against static rules.
 *
 * @param {Object} contribution
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateSignalContribution(contribution) {
  const errors = [];

  if (!contribution || typeof contribution !== 'object') {
    return { valid: false, errors: ['contribution must be a non-null object'] };
  }

  // signal_key
  const keyResult = validateSignalKey(contribution.signal_key);
  if (!keyResult.valid) errors.push(keyResult.error);

  // source_type
  if (!EVIDENCE_SOURCE_TYPES.includes(contribution.source_type)) {
    errors.push(`source_type "${contribution.source_type}" is not a valid evidence_source_enum value`);
  }

  // source_domain
  if (!INTELLIGENCE_DOMAINS.includes(contribution.source_domain)) {
    errors.push(`source_domain "${contribution.source_domain}" is not a valid intelligence_domain_enum value`);
  }

  // source_reference_id
  if (!contribution.source_reference_id || typeof contribution.source_reference_id !== 'string') {
    errors.push('source_reference_id must be a non-empty string');
  }

  // contribution_weight
  const weightResult = validateContributionWeight(contribution.contribution_weight);
  if (!weightResult.valid) errors.push(weightResult.error);

  // evidence_metadata
  if (contribution.evidence_metadata !== null &&
      contribution.evidence_metadata !== undefined &&
      typeof contribution.evidence_metadata !== 'object') {
    errors.push('evidence_metadata must be an object or null');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validates an array of SignalContributions.
 * Returns valid contributions and an errors log.
 *
 * @param {Object[]} contributions
 * @returns {{ valid: Object[], invalid: Array<{ contribution: Object, errors: string[] }> }}
 */
function filterValidContributions(contributions) {
  if (!Array.isArray(contributions)) {
    return { valid: [], invalid: [] };
  }

  const valid   = [];
  const invalid = [];

  for (const contribution of contributions) {
    const result = validateSignalContribution(contribution);
    if (result.valid) {
      valid.push(contribution);
    } else {
      invalid.push({ contribution, errors: result.errors });
    }
  }

  return { valid, invalid };
}

/**
 * Validates that a domain is compatible with a signal key.
 *
 * @param {string} signalKey
 * @param {string} sourceDomain
 * @returns {{ compatible: boolean, warning: string|null }}
 */
function validateDomainCompatibility(signalKey, sourceDomain) {
  const meta = SIGNAL_REGISTRY_METADATA[signalKey];
  if (!meta) {
    return { compatible: false, warning: `Signal "${signalKey}" not in local registry cache` };
  }

  if (!meta.compatible_domains.includes(sourceDomain)) {
    return {
      compatible: false,
      warning:    `Domain "${sourceDomain}" is not compatible with signal "${signalKey}". ` +
                  `Compatible domains: ${meta.compatible_domains.join(', ')}`,
    };
  }

  return { compatible: true, warning: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// BUNDLE VALIDATORS
// Validate a CrossDomainSignalBundle before persistence.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates a CrossDomainSignalBundle structure before DB writes.
 *
 * @param {Object} bundle
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
function validateSignalBundle(bundle) {
  const errors   = [];
  const warnings = [];

  if (!bundle || typeof bundle !== 'object') {
    return { valid: false, errors: ['bundle must be a non-null object'], warnings: [] };
  }

  // signal_weights
  if (!bundle.signal_weights || typeof bundle.signal_weights !== 'object') {
    errors.push('bundle.signal_weights must be an object');
  } else {
    for (const [key, weight] of Object.entries(bundle.signal_weights)) {
      const keyResult    = validateSignalKey(key);
      const weightResult = validateContributionWeight(weight);
      if (!keyResult.valid)    errors.push(`signal_weights: ${keyResult.error}`);
      if (!weightResult.valid) errors.push(`signal_weights["${key}"]: ${weightResult.error}`);
    }
  }

  // domain_vectors
  if (!bundle.domain_vectors || typeof bundle.domain_vectors !== 'object') {
    errors.push('bundle.domain_vectors must be an object');
  }

  // domains_included
  if (!Array.isArray(bundle.domains_included)) {
    errors.push('bundle.domains_included must be an array');
  } else {
    for (const domain of bundle.domains_included) {
      if (!INTELLIGENCE_DOMAINS.includes(domain)) {
        errors.push(`bundle.domains_included contains invalid domain: "${domain}"`);
      }
    }
  }

  // aggregation_version
  if (bundle.aggregation_version !== AGGREGATION_VERSION) {
    warnings.push(`bundle.aggregation_version "${bundle.aggregation_version}" differs from current version "${AGGREGATION_VERSION}"`);
  }

  // taxonomy_version
  if (bundle.taxonomy_version !== TAXONOMY_VERSION) {
    warnings.push(`bundle.taxonomy_version "${bundle.taxonomy_version}" differs from current version "${TAXONOMY_VERSION}"`);
  }

  // is_complete_vector type check
  if (typeof bundle.is_complete_vector !== 'boolean') {
    errors.push('bundle.is_complete_vector must be boolean');
  }

  // contradiction_metadata — warn if any strong contradictions
  if (typeof bundle.contradiction_metadata === 'object') {
    for (const [pairKey, entry] of Object.entries(bundle.contradiction_metadata)) {
      if (entry.severity === 'strong') {
        warnings.push(`Strong contradiction detected: ${pairKey} (weight_a: ${entry.weight_a}, weight_b: ${entry.weight_b})`);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// REGISTRY CONTRACT VALIDATOR
// Used by tests and CI pipelines to verify constants match migration seed.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verifies that all signal keys in ALL_SIGNAL_KEYS have metadata entries.
 * Returns a validation report for use in CI assertions.
 *
 * @returns {{ ok: boolean, missing: string[], extra: string[] }}
 */
function validateRegistryContract() {
  const metadataKeys    = Object.keys(SIGNAL_REGISTRY_METADATA);
  const missing         = ALL_SIGNAL_KEYS.filter((k) => !metadataKeys.includes(k));
  const extra           = metadataKeys.filter((k) => !ALL_SIGNAL_KEYS.includes(k));

  return {
    ok:      missing.length === 0 && extra.length === 0,
    missing,
    extra,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  // Static validators
  validateSignalKey,
  validateContributionWeight,
  validateSignalContribution,
  filterValidContributions,
  validateDomainCompatibility,

  // Bundle validators
  validateSignalBundle,

  // Registry contract
  validateRegistryContract,
};
