'use strict';

/**
 * @file src/services/confidence.service.js
 *
 * Phase 2 — Field-level and overall confidence scoring for parsed resumes.
 *
 * DESIGN PRINCIPLES:
 *  - Pure function — no I/O, no DB, no HTTP
 *  - Accepts HireRiseResume (structured) shape from the normalizer
 *  - Fully defensive: null/undefined safe on every field
 *  - Returns a frozen, serialisable confidence object
 *  - Does NOT modify the input resume object
 */

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

const CONFIDENCE_LEVELS = Object.freeze({
  HIGH:   'high',
  MEDIUM: 'medium',
  LOW:    'low',
});

const SOURCES = Object.freeze({
  REGEX:    'regex',
  AI:       'ai',
  INFERRED: 'inferred',
});

/**
 * Field weights must sum to 1.0.
 * These are used to compute the weighted overall score.
 */
const FIELD_WEIGHTS = Object.freeze({
  name:       0.15,
  email:      0.15,
  phone:      0.10,
  skills:     0.20,
  experience: 0.25,
  education:  0.15,
});

/** Thresholds for overall confidence level classification */
const LEVEL_THRESHOLDS = Object.freeze({
  HIGH:   0.85,
  MEDIUM: 0.60,
});

// ─── Regex validators ─────────────────────────────────────────────────────────

const EMAIL_REGEX    = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_REGEX    = /[\d\s\-+().]{7,20}/;
// A name is considered valid if it has at least two word chars and at least one space
const NAME_REGEX     = /^[A-Za-zÀ-ÿ'-]{2,}(?:\s+[A-Za-zÀ-ÿ'-]{1,})+$/;

// ─── Field scorers ────────────────────────────────────────────────────────────

/**
 * Score the `name` field.
 * High  → present, regex-valid, properly capitalised
 * Medium → present but single word or unusual characters
 * Low   → missing or very short
 *
 * @param {string|null|undefined} fullName
 * @returns {{ score: number, level: string, source: string }}
 */
function scoreName(fullName) {
  const name = (fullName ?? '').trim();

  if (!name || name.length < 2) {
    return { score: 0.0, rawScore: 0.0, level: CONFIDENCE_LEVELS.LOW, source: SOURCES.INFERRED };
  }

  if (NAME_REGEX.test(name)) {
    // Bonus if properly title-cased (at least first letter upper)
    const isTitleCase = name.split(/\s+/).every(w => /^[A-ZÀ-Ÿ]/.test(w));
    const score = isTitleCase ? 0.95 : 0.80;
    return { score, rawScore: score, level: CONFIDENCE_LEVELS.HIGH, source: SOURCES.REGEX };
  }

  // Present but doesn't pass regex — single word name or unusual chars
  return { score: 0.55, rawScore: 0.55, level: CONFIDENCE_LEVELS.MEDIUM, source: SOURCES.INFERRED };
}

/**
 * Score the `email` field.
 * High   → valid email regex match
 * Medium → present but malformed
 * Low    → missing
 *
 * @param {string|null|undefined} email
 * @returns {{ score: number, level: string, source: string }}
 */
function scoreEmail(email) {
  const e = (email ?? '').trim();

  if (!e) {
    return { score: 0.0, rawScore: 0.0, level: CONFIDENCE_LEVELS.LOW, source: SOURCES.INFERRED };
  }

  if (EMAIL_REGEX.test(e)) {
    return { score: 0.97, rawScore: 0.97, level: CONFIDENCE_LEVELS.HIGH, source: SOURCES.REGEX };
  }

  // Present but doesn't look like a valid email
  return { score: 0.40, rawScore: 0.40, level: CONFIDENCE_LEVELS.MEDIUM, source: SOURCES.INFERRED };
}

/**
 * Score the `phone` field.
 * High   → passes phone regex with sufficient digits
 * Medium → present but short/unusual
 * Low    → missing
 *
 * @param {string|null|undefined} phone
 * @returns {{ score: number, level: string, source: string }}
 */
function scorePhone(phone) {
  const p = (phone ?? '').trim();

  if (!p) {
    return { score: 0.0, rawScore: 0.0, level: CONFIDENCE_LEVELS.LOW, source: SOURCES.INFERRED };
  }

  // Count digits only — need at least 7
  const digitCount = (p.match(/\d/g) ?? []).length;

  if (PHONE_REGEX.test(p) && digitCount >= 7) {
    return { score: 0.90, rawScore: 0.90, level: CONFIDENCE_LEVELS.HIGH, source: SOURCES.REGEX };
  }

  return { score: 0.45, rawScore: 0.45, level: CONFIDENCE_LEVELS.MEDIUM, source: SOURCES.INFERRED };
}

/**
 * Score the `skills` array.
 *
 * Scoring heuristic:
 *  - 0 skills → 0.0
 *  - 1–2 skills → 0.35 (very weak — likely inferred)
 *  - 3–5 skills → 0.65 (moderate — from section, but sparse)
 *  - 6–9 skills → 0.80 (good)
 *  - 10+ skills → 0.92 (strong evidence of a dedicated skills section)
 *
 * Source is 'regex' when count ≥ 3 (parsed from section), else 'inferred'.
 *
 * @param {Array<{name:string}>|null|undefined} skills
 * @returns {{ score: number, level: string, source: string }}
 */
function scoreSkills(skills) {
  const list = Array.isArray(skills) ? skills.filter(s => (s?.name ?? '').trim()) : [];
  const count = list.length;

  if (count === 0) {
    return { score: 0.0, rawScore: 0.0, level: CONFIDENCE_LEVELS.LOW, source: SOURCES.INFERRED };
  }
  if (count <= 2) {
    return { score: 0.35, rawScore: 0.35, level: CONFIDENCE_LEVELS.LOW, source: SOURCES.INFERRED };
  }
  if (count <= 5) {
    return { score: 0.65, rawScore: 0.65, level: CONFIDENCE_LEVELS.MEDIUM, source: SOURCES.AI };
  }
  if (count <= 9) {
    return { score: 0.80, rawScore: 0.80, level: CONFIDENCE_LEVELS.MEDIUM, source: SOURCES.AI };
  }

  return { score: 0.92, rawScore: 0.92, level: CONFIDENCE_LEVELS.HIGH, source: SOURCES.AI };
}

/**
 * Score the `experience` array.
 *
 * Deductions applied:
 *  - Missing company name         → −0.05 per entry
 *  - Missing dates entirely       → −0.08 per entry
 *  - Missing description          → −0.04 per entry
 *
 * @param {Array|null|undefined} experience
 * @returns {{ score: number, level: string, source: string }}
 */
function scoreExperience(experience) {
  const list = Array.isArray(experience) ? experience : [];

  if (list.length === 0) {
    return { score: 0.0, rawScore: 0.0, level: CONFIDENCE_LEVELS.LOW, source: SOURCES.INFERRED };
  }

  // Base score scales with number of entries, capped
  let base = Math.min(0.90, 0.50 + list.length * 0.08);

  let totalDeduction = 0;
  for (const entry of list) {
    if (!(entry?.company ?? '').trim())     totalDeduction += 0.05;
    if (!entry?.startDate && !entry?.start_date) totalDeduction += 0.08;
    if (!(entry?.description ?? '').trim()) totalDeduction += 0.04;
  }

  // Average deduction across entries so a single bad entry doesn't tank score
  const avgDeduction = totalDeduction / list.length;
  const rawScore = Math.max(0, Math.min(1, base - avgDeduction));
  const score = Math.max(0, Math.min(1, rawScore));

  return {
    score:    Number(score.toFixed(2)),
    rawScore: Number(rawScore.toFixed(2)),
    level:    levelFromScore(score),
    source:   SOURCES.AI,
  };
}

/**
 * Score the `education` array.
 *
 * @param {Array|null|undefined} education
 * @returns {{ score: number, level: string, source: string }}
 */
function scoreEducation(education) {
  const list = Array.isArray(education) ? education : [];

  if (list.length === 0) {
    return { score: 0.0, rawScore: 0.0, level: CONFIDENCE_LEVELS.LOW, source: SOURCES.INFERRED };
  }

  let base = Math.min(0.90, 0.55 + list.length * 0.10);

  let totalDeduction = 0;
  for (const entry of list) {
    if (!(entry?.institution ?? '').trim()) totalDeduction += 0.06;
    if (!entry?.endYear && !entry?.year)    totalDeduction += 0.05;
  }

  const avgDeduction = totalDeduction / list.length;
  const rawScore = Math.max(0, Math.min(1, base - avgDeduction));
  const score = Math.max(0, Math.min(1, rawScore));

  return {
    score:    Number(score.toFixed(2)),
    rawScore: Number(rawScore.toFixed(2)),
    level:    levelFromScore(score),
    source:   SOURCES.AI,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Classify a numeric score into a confidence level.
 * @param {number} score - 0–1
 * @returns {string}
 */
function levelFromScore(score) {
  if (score >= LEVEL_THRESHOLDS.HIGH)   return CONFIDENCE_LEVELS.HIGH;
  if (score >= LEVEL_THRESHOLDS.MEDIUM) return CONFIDENCE_LEVELS.MEDIUM;
  return CONFIDENCE_LEVELS.LOW;
}

/**
 * Compute the weighted overall confidence score from field scores.
 * @param {{ [field: string]: { score: number } }} fields
 * @returns {number} - 0–1, rounded to 2dp
 */
function computeOverallScore(fields) {
  let weighted = 0;

  for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
    const fieldScore = fields[field]?.score ?? 0;
    weighted += fieldScore * weight;
  }

  return Number(weighted.toFixed(2));
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Compute field-level and overall confidence for a parsed resume.
 *
 * Accepts the HireRiseResume structured shape (output of resume.normalizer.js).
 * Safe to call with null/undefined — returns a zero-confidence object.
 *
 * @param {object|null|undefined} structuredResume - HireRiseResume
 * @param {{ isTruncated?: boolean }} [options={}]
 * @returns {{
 *   overall: number,
 *   level: string,
 *   version: string,
 *   computedAt: string,
 *   fields: {
 *     name:       { score: number, rawScore: number, level: string, source: string },
 *     email:      { score: number, rawScore: number, level: string, source: string },
 *     phone:      { score: number, rawScore: number, level: string, source: string },
 *     skills:     { score: number, rawScore: number, level: string, source: string },
 *     experience: { score: number, rawScore: number, level: string, source: string },
 *     education:  { score: number, rawScore: number, level: string, source: string },
 *   }
 * }}
 */
function computeConfidence(structuredResume, options = {}) {
  // Safe fallback if called with null/undefined
  if (!structuredResume || typeof structuredResume !== 'object') {
    return _zeroConfidence();
  }

  const core       = structuredResume.core       ?? {};
  const skills     = structuredResume.skills     ?? [];
  const experience = structuredResume.experience ?? [];
  const education  = structuredResume.education  ?? [];

  const fields = {
    name:       scoreName(core.fullName),
    email:      scoreEmail(core.email),
    phone:      scorePhone(core.phone),
    skills:     scoreSkills(skills),
    experience: scoreExperience(experience),
    education:  scoreEducation(education),
  };

  let overall = computeOverallScore(fields);

  // Apply truncation penalty if resume is flagged as truncated
  if (options.isTruncated === true) {
    overall = Number(Math.max(0, overall - 0.1).toFixed(2));
  }

  const level = levelFromScore(overall);

  return Object.freeze({
    overall,
    level,
    version:    '2.0.0',
    computedAt: new Date().toISOString(),
    fields:     Object.freeze(fields),
  });
}

/**
 * Returns a zero-confidence object — used as a safe fallback.
 * @returns {object}
 */
function _zeroConfidence() {
  const zeroField = { score: 0, rawScore: 0, level: CONFIDENCE_LEVELS.LOW, source: SOURCES.INFERRED };
  return Object.freeze({
    overall:    0,
    level:      CONFIDENCE_LEVELS.LOW,
    version:    '2.0.0',
    computedAt: new Date().toISOString(),
    fields:     Object.freeze({
      name:       { ...zeroField },
      email:      { ...zeroField },
      phone:      { ...zeroField },
      skills:     { ...zeroField },
      experience: { ...zeroField },
      education:  { ...zeroField },
    }),
  });
}

module.exports = Object.freeze({
  computeConfidence,
  levelFromScore,
  CONFIDENCE_LEVELS,
  SOURCES,
  FIELD_WEIGHTS,
  LEVEL_THRESHOLDS,
  // Exported for unit testing
  _scorers: { scoreName, scoreEmail, scorePhone, scoreSkills, scoreExperience, scoreEducation },
});