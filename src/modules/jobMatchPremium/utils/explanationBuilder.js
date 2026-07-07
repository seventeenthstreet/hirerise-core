'use strict';

/**
 * src/modules/jobMatchPremium/utils/explanationBuilder.js
 *
 * Engine 6 — Explanation Builder
 *
 * Produces 3–5 deterministic, PII-safe reason strings from numeric signals.
 *
 * Rules (WP-1-SPEC-01, WP-12-SPEC-01, Canonical Explainability Contract):
 * - Deterministic: same inputs → same output
 * - No AI calls
 * - 3–5 reasons returned
 * - PII safe: no names, emails, resume text, job description text
 * - Derives all language from numeric signals only
 */

const { TIERS } = require('./tierClassifier');

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function clamp(n, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, Math.round(Number(n) || 0)));
}

function skillCoveragePercent(breakdown) {
  // Skills sub-score is out of 30 (W.skills weight), normalise to percentage
  const raw = clamp(breakdown.skills ?? 0);
  // If the score is already 0–100, just use it; if it's 0–30 scale it up
  if (raw <= 30) {
    return Math.round((raw / 30) * 100);
  }
  return raw;
}

// ─────────────────────────────────────────────────────────────────────────────
// REASON GENERATORS
// Each returns a string or null. Null means the signal doesn't add value.
// ─────────────────────────────────────────────────────────────────────────────

function reasonMatchScore(matchScore, tier) {
  const pct = clamp(matchScore);
  switch (tier) {
    case TIERS.HIGH:
      return `Your profile is a strong match for this role (${pct}/100).`;
    case TIERS.MEDIUM:
      return `Your profile is a partial match for this role (${pct}/100) with room for targeted improvement.`;
    case TIERS.LOW:
      return `Your profile currently has a low match score (${pct}/100) — focused upskilling is recommended.`;
    default:
      return `Insufficient profile data to generate a match score. Complete your profile for a full assessment.`;
  }
}

function reasonSkills(breakdown) {
  const coverage = skillCoveragePercent(breakdown);
  if (coverage >= 70) {
    return `Your skills profile covers approximately ${coverage}% of role requirements.`;
  }
  if (coverage >= 40) {
    return `Your skills profile covers approximately ${coverage}% of role requirements — adding relevant skills will improve your match.`;
  }
  return `Your skills profile covers approximately ${coverage}% of role requirements. Targeted skill development is your highest-impact lever.`;
}

function reasonExperience(breakdown, careerLevel) {
  const score = clamp(breakdown.experience ?? 0, 0, 25);
  const scaledPct = Math.round((score / 25) * 100);

  if (scaledPct >= 80) {
    return `Your experience level (${careerLevel}) aligns well with role expectations.`;
  }
  if (scaledPct >= 40) {
    return `Your experience level (${careerLevel}) partially meets role requirements.`;
  }
  return `Limited experience detected for this role level. Consider roles at the ${careerLevel} tier that match your current experience.`;
}

function reasonEducation(breakdown) {
  const score = clamp(breakdown.education ?? 0, 0, 15);
  const scaledPct = Math.round((score / 15) * 100);

  if (scaledPct >= 80) {
    return `Your education meets or exceeds baseline qualification requirements.`;
  }
  if (scaledPct >= 50) {
    return `Your education partially meets qualification requirements for this role.`;
  }
  return null; // Low education score without context isn't actionable as a reason
}

function reasonMarketDemand(breakdown) {
  const demand = breakdown.marketDemand;
  if (demand == null) return null;

  const d = clamp(demand);
  if (d >= 70) {
    return `Market demand for this role is high (${d}/100), improving your hiring prospects.`;
  }
  if (d >= 40) {
    return `Market demand for this role is moderate (${d}/100).`;
  }
  return `Market demand for this role is currently low (${d}/100) — consider adjacent roles with higher demand.`;
}

function reasonSkillGap(skillGap) {
  const missing = skillGap?.missingSkills ?? [];
  const highPriority = missing.filter((s) => s.priority === 'high_priority');

  if (highPriority.length === 0 && missing.length === 0) {
    return `No critical skill gaps detected relative to role requirements.`;
  }
  if (highPriority.length > 0) {
    return `${highPriority.length} high-priority skill gap${highPriority.length > 1 ? 's' : ''} identified. Closing these can materially improve your match score.`;
  }
  return `${missing.length} skill gap${missing.length > 1 ? 's' : ''} identified. These are low-to-medium priority for this role.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN BUILDER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds a deterministic, PII-safe explanation payload.
 *
 * @param {object} params
 * @param {number} params.matchScore
 * @param {string} params.tier               - HIGH | MEDIUM | LOW | NO_DATA
 * @param {object} params.breakdown          - { skills, experience, education, marketDemand }
 * @param {object} params.skillGap           - { missingSkills: [] }
 * @param {string} [params.careerLevel]      - entry | mid | senior | lead
 * @returns {{ reasons: string[] }}
 */
function buildExplanation({ matchScore, tier, breakdown, skillGap, careerLevel = 'mid' }) {
  const candidates = [
    reasonMatchScore(matchScore, tier),
    reasonSkills(breakdown),
    reasonExperience(breakdown, careerLevel),
    reasonMarketDemand(breakdown),
    reasonSkillGap(skillGap),
    reasonEducation(breakdown),
  ].filter(Boolean);

  // Guarantee 3–5 reasons
  const reasons = candidates.slice(0, 5);
  while (reasons.length < 3) {
    reasons.push('Complete additional profile sections for a more detailed assessment.');
  }

  return { reasons };
}

module.exports = { buildExplanation };
