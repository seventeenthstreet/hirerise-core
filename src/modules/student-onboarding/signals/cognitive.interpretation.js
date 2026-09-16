'use strict';

/**
 * src/modules/student-onboarding/signals/cognitive.interpretation.js
 *
 * STUDENT-NATIVE COGNITIVE INTERPRETATION — Phase 3B.4B
 *
 * Pure, deterministic interpretation layer over the already-persisted
 * `student_cognitive_signals` representation (built by cognitive.signals.js
 * and written by cognitive.service.js#commitCognitiveStep).
 *
 * LOCKED CONTRACT (Phase 3B.4A, approved):
 *   ✓ Dominant domain  = highest average of domain_vectors[domain].weights.
 *     Domains with no usable numeric weights are EXCLUDED from ranking —
 *     never scored as a competing zero.
 *   ✓ Ties (domain or tag) broken by canonical taxonomy declaration order
 *     (COGNITIVE_DOMAINS / ALL_COGNITIVE_SIGNAL_TAGS), never lexical,
 *     random, timestamp, or DB ordering.
 *   ✓ Dominant tags are REUSED as-is from the canonical cognitive
 *     derivation (domain_vectors[domain].dominant_tags, global
 *     signal_tags) — never recalculated here, never a new threshold.
 *   ✓ No secondary tendency tier in v1.
 *   ✓ Semantic output is restricted to tendency/preference/pattern
 *     language — never score/aptitude/IQ/intelligence/personality/
 *     diagnosis framing.
 *   ✓ No new descriptors/narrative — machine-readable tags/domains only.
 *   ✓ metadata.extraction_version is passed through as extraction_version;
 *     no taxonomy_version column is introduced or assumed.
 *   ✓ No persistence — this module performs no DB/network/AI calls and is
 *     re-derivable from student_cognitive_signals on every call.
 *
 * This module MUST NOT:
 *   ✗ recreate raw signal derivation (that remains cognitive.signals.js)
 *   ✗ call the database, network, or any AI/LLM
 *   ✗ import services, controllers, or repositories
 *   ✗ mutate its input
 */

const {
  COGNITIVE_DOMAINS,
  ALL_COGNITIVE_SIGNAL_TAGS,
} = require('../constants/cognitive');

// ─────────────────────────────────────────────────────────────────────────────
// TYPE DOCUMENTATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} RankedDomainEntry
 * @property {string} domain          — one of COGNITIVE_DOMAINS
 * @property {number} average_weight  — average of domain_vectors[domain].weights
 * @property {string[]} dominant_tags — pass-through of domain_vectors[domain].dominant_tags
 */

/**
 * @typedef {Object} CognitiveInterpretation
 * @property {RankedDomainEntry[]} ranked_domains — domains with usable data,
 *   ordered descending by average_weight, ties broken by COGNITIVE_DOMAINS order
 * @property {string|null} dominant_domain — first entry of ranked_domains, or null
 * @property {string[]} signal_tags        — pass-through of the canonical global tags
 * @property {number} response_count       — pass-through
 * @property {boolean} is_partial          — pass-through
 * @property {string|null} extraction_version — pass-through of metadata.extraction_version
 */

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Canonical taxonomy-order comparator for domains.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareDomainOrder(a, b) {
  return COGNITIVE_DOMAINS.indexOf(a) - COGNITIVE_DOMAINS.indexOf(b);
}

/**
 * Computes the average of a domain's tag weights.
 * Returns null (not 0) when the domain has no usable numeric weights, so
 * callers can distinguish "no data" from a genuine zero-valued domain.
 *
 * @param {{ [tag: string]: number }|undefined|null} weights
 * @returns {number|null}
 */
function computeDomainAverage(weights) {
  if (!weights || typeof weights !== 'object') return null;

  const values = Object.values(weights).filter(
    (w) => typeof w === 'number' && Number.isFinite(w),
  );

  if (values.length === 0) return null;

  const sum = values.reduce((acc, w) => acc + w, 0);
  return parseFloat((sum / values.length).toFixed(4));
}

// ─────────────────────────────────────────────────────────────────────────────
// rankDomains()
// Builds the deterministic ranked_domains list from domain_vectors.
// Domains with no usable data are excluded entirely (not zero-scored).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {{ [domain: string]: { weights?: object, dominant_tags?: string[] } }} domainVectors
 * @returns {RankedDomainEntry[]}
 */
function rankDomains(domainVectors) {
  const vectors = domainVectors && typeof domainVectors === 'object' ? domainVectors : {};

  const usable = [];
  for (const domain of COGNITIVE_DOMAINS) {
    const vector = vectors[domain];
    const average = vector ? computeDomainAverage(vector.weights) : null;
    if (average === null) continue; // no usable data — excluded, not zero-scored

    usable.push({
      domain,
      average_weight: average,
      dominant_tags: Array.isArray(vector.dominant_tags) ? vector.dominant_tags : [],
    });
  }

  usable.sort((a, b) => {
    if (b.average_weight !== a.average_weight) {
      return b.average_weight - a.average_weight;
    }
    return compareDomainOrder(a.domain, b.domain);
  });

  return usable;
}

// ─────────────────────────────────────────────────────────────────────────────
// interpretCognitiveSignals()
// Top-level entry point. Accepts a canonical student_cognitive_signals
// representation and returns the Student-native interpretation.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {{
 *   domain_vectors?: object,
 *   signal_weights?: object,
 *   signal_tags?: string[],
 *   response_count?: number,
 *   is_partial?: boolean,
 *   extracted_at?: string|null,
 *   metadata?: { extraction_version?: string },
 * }} cognitiveSignals — canonical student_cognitive_signals row (or equivalent bundle output)
 * @returns {CognitiveInterpretation}
 */
function interpretCognitiveSignals(cognitiveSignals) {
  const source = cognitiveSignals && typeof cognitiveSignals === 'object' ? cognitiveSignals : {};

  const ranked_domains = rankDomains(source.domain_vectors);
  const dominant_domain = ranked_domains.length > 0 ? ranked_domains[0].domain : null;

  const signal_tags = Array.isArray(source.signal_tags)
    ? source.signal_tags.filter((tag) => ALL_COGNITIVE_SIGNAL_TAGS.includes(tag))
    : [];

  return {
    ranked_domains,
    dominant_domain,
    signal_tags,
    response_count: typeof source.response_count === 'number' ? source.response_count : 0,
    is_partial: source.is_partial !== false, // default true (unknown ⇒ treat as not-yet-final)
    extraction_version: source.metadata && typeof source.metadata.extraction_version === 'string'
      ? source.metadata.extraction_version
      : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  interpretCognitiveSignals,
  rankDomains,
  computeDomainAverage,
};
