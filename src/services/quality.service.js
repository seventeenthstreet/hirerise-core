'use strict';

/**
 * @file src/services/quality.service.js
 *
 * Phase 2 — Resume quality and completeness scoring.
 *
 * DESIGN PRINCIPLES:
 *  - Pure function — no I/O, no DB, no HTTP
 *  - Accepts HireRiseResume (structured) shape from the normalizer
 *  - Fully defensive: null/undefined safe on every field
 *  - Returns a frozen, serialisable quality object
 *  - Does NOT modify the input resume object
 *
 * QUALITY DIMENSIONS:
 *  1. completenessScore — fraction of important fields populated (0–1)
 *  2. missingFields     — array of field names that are absent
 *  3. suggestions       — human-readable actionable improvement hints
 */

'use strict';

// ─── Field definitions ────────────────────────────────────────────────────────

/**
 * Each entry describes one quality dimension.
 *
 * weight  : contribution to completenessScore (all must sum to 1.0)
 * check   : (resume) → boolean — returns true when the field is present/adequate
 * missing : label used in missingFields array when check fails
 * suggest : suggestion string shown to the user when check fails
 */
const QUALITY_DIMENSIONS = Object.freeze([
  {
    field:   'name',
    weight:  0.12,
    check:   (r) => (r?.core?.fullName ?? '').trim().length >= 2,
    missing: 'name',
    suggest: 'Add your full name so employers can identify you.',
  },
  {
    field:   'email',
    weight:  0.12,
    check:   (r) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test((r?.core?.email ?? '').trim()),
    missing: 'email',
    suggest: 'Add a professional email address.',
  },
  {
    field:   'phone',
    weight:  0.08,
    check:   (r) => ((r?.core?.phone ?? '').match(/\d/g) ?? []).length >= 7,
    missing: 'phone',
    suggest: 'Add a contact phone number.',
  },
  {
    field:   'location',
    weight:  0.05,
    check:   (r) => (r?.core?.location ?? '').trim().length >= 2,
    missing: 'location',
    suggest: 'Add your city or country so employers know your region.',
  },
  {
    field:   'summary',
    weight:  0.10,
    check:   (r) => (r?.core?.summary ?? '').trim().length >= 40,
    missing: 'summary',
    suggest: 'Add a professional summary (2–4 sentences) to introduce yourself.',
  },
  {
    field:   'skills',
    weight:  0.18,
    check:   (r) => (r?.skills ?? []).filter(s => (s?.name ?? '').trim()).length >= 3,
    missing: 'skills',
    suggest: 'Add at least 3 relevant skills — recruiters filter by skills heavily.',
  },
  {
    field:   'experience',
    weight:  0.20,
    check:   (r) => (r?.experience ?? []).length >= 1,
    missing: 'experience',
    suggest: 'Add your work history — even internships or part-time roles count.',
  },
  {
    field:   'experience_descriptions',
    weight:  0.08,
    check:   (r) => {
      const exp = r?.experience ?? [];
      if (exp.length === 0) return false;
      // At least one entry has a non-trivial description
      return exp.some(e => (e?.description ?? '').trim().length >= 30);
    },
    missing: 'experience_descriptions',
    suggest: 'Add descriptions to your experience entries — bullet your achievements.',
  },
  {
    field:   'education',
    weight:  0.07,
    check:   (r) => (r?.education ?? []).length >= 1,
    missing: 'education',
    suggest: 'Add your highest qualification.',
  },
]);

// Sanity check — weights must sum to 1.0 (± floating point tolerance)
const _weightSum = QUALITY_DIMENSIONS.reduce((s, d) => s + d.weight, 0);
if (Math.abs(_weightSum - 1.0) > 0.001) {
  throw new Error(`[quality.service] QUALITY_DIMENSIONS weights sum to ${_weightSum}, expected 1.0`);
}

// ─── Optional bonus dimensions ────────────────────────────────────────────────
// These do NOT affect completenessScore but generate suggestions when missing.

const BONUS_SUGGESTIONS = Object.freeze([
  {
    check:   (r) => {
      const certs = (r?.additionalSections ?? []).find(s => s.title === 'Certifications');
      return (certs?.items ?? []).length > 0;
    },
    suggest: 'Add relevant certifications to stand out (e.g. AWS, PMP, CFA).',
  },
  {
    check:   (r) => {
      const projects = (r?.additionalSections ?? []).find(s => s.title === 'Projects');
      return (projects?.items ?? []).length > 0;
    },
    suggest: 'Add a projects section to showcase hands-on work.',
  },
  {
    check:   (r) => {
      const exp = r?.experience ?? [];
      return exp.length >= 2;
    },
    suggest: 'Adding more experience entries increases your profile strength significantly.',
  },
  {
    check:   (r) => (r?.skills ?? []).filter(s => (s?.name ?? '').trim()).length >= 8,
    suggest: 'Expand your skills list to at least 8 — aim for a mix of technical and soft skills.',
  },
]);

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Compute resume quality for a parsed resume.
 *
 * Accepts the HireRiseResume structured shape (output of resume.normalizer.js).
 * Safe to call with null/undefined — returns a zero-quality object.
 *
 * @param {object|null|undefined} structuredResume - HireRiseResume
 * @returns {{
 *   completenessScore: number,     // 0–1
 *   missingFields:     string[],   // field names that failed their check
 *   suggestions:       string[],   // human-readable improvement hints
 * }}
 */
function computeQuality(structuredResume) {
  if (!structuredResume || typeof structuredResume !== 'object') {
    return _zeroQuality();
  }

  let score = 0;
  const missingFields = [];
  const suggestions   = [];

 // ── Core dimensions ────────────────────────────────────────────────────────
for (const dim of QUALITY_DIMENSIONS) {
  const present = _safeCheck(dim.check, structuredResume);
  if (present) {
    score += dim.weight;
  } else {
    missingFields.push(dim.missing);
    suggestions.push(dim.suggest);
  }
}

// ── Bonus suggestions (don't affect score) ─────────────────────────────────
for (const bonus of BONUS_SUGGESTIONS) {
  if (!_safeCheck(bonus.check, structuredResume)) {
    suggestions.push(bonus.suggest);
  }
}

// ── Final scoring + deduplication ──────────────────────────────────────────
const completenessScore = Number(score.toFixed(2));

// Deduplicate suggestions (prevents repeated UX hints)
const uniqueSuggestions = [...new Set(suggestions)];

return Object.freeze({
  completenessScore,
  version: '2.0.0',
  computedAt: new Date().toISOString(),
  missingFields: Object.freeze([...missingFields]),
  suggestions: Object.freeze(uniqueSuggestions),
});
}
/**
 * Safe wrapper around a check function — never throws.
 * @param {Function} checkFn
 * @param {object} resume
 * @returns {boolean}
 */
function _safeCheck(checkFn, resume) {
  try {
    return Boolean(checkFn(resume));
  } catch {
    return false;
  }
}

/**
 * Returns a zero-quality object — used as a safe fallback.
 * @returns {object}
 */
function _zeroQuality() {
  return Object.freeze({
    completenessScore: 0,
    missingFields:     Object.freeze(QUALITY_DIMENSIONS.map(d => d.missing)),
    suggestions:       Object.freeze(QUALITY_DIMENSIONS.map(d => d.suggest)),
  });
}

module.exports = Object.freeze({
  computeQuality,
  QUALITY_DIMENSIONS,
  BONUS_SUGGESTIONS,
});
