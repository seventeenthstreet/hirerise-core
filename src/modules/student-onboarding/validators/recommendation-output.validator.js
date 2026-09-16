'use strict';

/**
 * src/modules/student-onboarding/validators/recommendation-output.validator.js
 *
 * PHASE 1 — RECOMMENDATION OUTPUT STRUCTURAL VALIDATION
 * ══════════════════════════════════════════════════════
 * Replaces the previous weak 3-key presence check
 * (`!result.strengthSummary || !result.streamScores || !result.recommendedDomains`)
 * with real structural/schema validation (Phase 1 spec §9), using this
 * repository's existing `zod` dependency (already used elsewhere, e.g.
 * coverLetter.routes.js) rather than introducing a new validation
 * framework.
 *
 * Validates:
 *   - malformed JSON (via parseRecommendationOutput);
 *   - missing required fields;
 *   - wrong field types;
 *   - invalid enum/value fields;
 *   - invalid `careerAreaKey` (must be one of the governed, currently-active
 *     Career Area canonical keys, when a governed key list is supplied —
 *     see §10 / career-area.repository.js);
 *   - structurally incomplete Recommendation output.
 *
 * This module contains NO AI-provider dependency and does not read from
 * or write to the database. It is intentionally kept independent of
 * recommendation-engine.js so it stays independently testable.
 *
 * SAFETY: validation failure messages returned by this module are always
 * short, structural (zod issue path + message only) and never include the
 * raw AI payload/prompt — safe to surface further upstream (e.g. into
 * `error_detail`) per Phase 1 spec §9's "must never contain secrets,
 * prompts, model payloads, or stack traces" requirement.
 *
 * Public API:
 *   parseRecommendationOutput(rawText) → { ok: true, data } | { ok: false, error }
 *   validateRecommendationOutput(candidate, [options]) → { ok: true, data } | { ok: false, error }
 */

const { z } = require('zod');

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

const StreamScoreSchema = z.object({
  stream: z.enum(['science', 'commerce', 'humanities']),
  score: z.number().min(0).max(100),
  label: z.string().min(1),
  rationale: z.string().min(1),
});

const RecommendedDomainSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  whyItFitsYou: z.string().min(1),
  futureScore: z.number().min(0).max(100),
  aiRiskScore: z.number().min(0).max(100),
  humanEdgeScore: z.number().min(0).max(100),
  employabilityScore: z.number().min(0).max(100),
  roiPotential: z.enum(['low', 'medium', 'high', 'very_high']),
  globalOpportunity: z.enum(['local', 'national', 'global']),
  exampleRoles: z.array(z.string().min(1)).min(1),
  entryPaths: z.array(z.string().min(1)).min(1),
  aiEraGuidance: z.string().min(1),
});

/**
 * Top-level Recommendation output shape.
 *
 * `careerAreaKey` (Phase 1 spec §10) is nullable and additive. Its
 * membership in the governed vocabulary is checked separately (below),
 * not baked into this static schema, because the governed list is a
 * runtime value read from cms_career_domains, not a compile-time constant
 * — this module never hardcodes a competing vocabulary.
 */
const RecommendationOutputSchema = z.object({
  strengthSummary: z.object({
    traits: z.array(z.string().min(1)).min(1),
    academicInsights: z.array(z.string().min(1)),
    exposureHighlights: z.array(z.string().min(1)),
  }),
  streamScores: z.array(StreamScoreSchema).min(1),
  recommendedDomains: z.array(RecommendedDomainSchema).min(1),
  careerAreaKey: z.string().min(1).nullable().optional(),
  futureCareerNote: z.string().min(1),
});

// ─────────────────────────────────────────────────────────────────────────────
// JSON parsing (malformed JSON handling)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parses raw AI provider text into a candidate object. Strips accidental
 * markdown code fences (existing pre-Phase-1 tolerance, preserved
 * unchanged). Never throws — returns a structured failure instead so
 * callers can safely funnel it into a safe, secret-free error message.
 *
 * @param {string} rawText
 * @returns {{ ok: true, data: unknown } | { ok: false, error: string }}
 */
function parseRecommendationOutput(rawText) {
  if (typeof rawText !== 'string' || rawText.trim().length === 0) {
    return { ok: false, error: 'Recommendation output was empty' };
  }

  const cleaned = rawText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

  try {
    return { ok: true, data: JSON.parse(cleaned) };
  } catch {
    return { ok: false, error: 'Recommendation output was not valid JSON' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Structural validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Formats zod issues into a short, safe, structural summary. Never
 * includes the offending value (which may echo back large chunks of the
 * AI payload) — path + message only.
 *
 * @param {import('zod').ZodError} zodError
 * @returns {string}
 */
function formatZodError(zodError) {
  return zodError.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

/**
 * Validates a parsed Recommendation output candidate against the
 * structural schema, then (if a governed key list is supplied) against
 * the governed Career Area vocabulary.
 *
 * @param {unknown} candidate
 * @param {Object} [options]
 * @param {string[]} [options.governedCareerAreaKeys] — the currently-active
 *   governed Career Area canonical keys (see career-area.repository.js).
 *   When omitted, `careerAreaKey` membership is not checked (structural
 *   shape only) — callers that can supply the governed list should always
 *   do so before persistence.
 * @returns {{ ok: true, data: Object } | { ok: false, error: string }}
 */
function validateRecommendationOutput(candidate, { governedCareerAreaKeys } = {}) {
  const result = RecommendationOutputSchema.safeParse(candidate);

  if (!result.success) {
    return { ok: false, error: formatZodError(result.error) };
  }

  const { data } = result;
  const careerAreaKey = data.careerAreaKey ?? null;

  if (careerAreaKey !== null && Array.isArray(governedCareerAreaKeys)) {
    if (!governedCareerAreaKeys.includes(careerAreaKey)) {
      return {
        ok: false,
        error: `careerAreaKey: not a governed Career Area value`,
      };
    }
  }

  return { ok: true, data: { ...data, careerAreaKey } };
}

module.exports = {
  RecommendationOutputSchema,
  parseRecommendationOutput,
  validateRecommendationOutput,
};
