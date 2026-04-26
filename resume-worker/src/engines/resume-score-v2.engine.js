'use strict';

/**
 * @file resume-worker/src/engines/resume-score-v2.engine.js
 *
 * Resume Score Engine — v2 (HireRise Schema-aware)
 *
 * WHAT CHANGED vs v1:
 *  - Accepts the structured HireRiseResume schema (resume.core, resume.experience, etc.)
 *  - Falls back to v1 raw shape if a non-normalized object is passed (backward compat)
 *  - experience scoring accounts for type: job/internship/project
 *  - education scoring uses degree strings (Doctor/Master/Bachelor/Diploma/etc.)
 *  - completeness scoring uses resume.metadata.completenessScore directly
 *  - skills scoring uses resume.skills[].name
 *  - formatting scoring uses metadata.parsingConfidence as a proxy for doc quality
 */

const {
  safe,
  EXPERIENCE_TYPES,
} = require('../../shared/hirerise-resume.schema');

const WEIGHTS = Object.freeze({
  completeness: 0.25,
  skills:       0.30,
  experience:   0.25,
  education:    0.10,
  formatting:   0.10,
});

const HIGH_VALUE_SKILLS = new Set([
  'python', 'typescript', 'javascript', 'kubernetes', 'terraform',
  'react', 'node.js', 'nodejs', 'aws', 'gcp', 'azure', 'machine learning',
  'system design', 'sql', 'docker', 'graphql', 'rust', 'go', 'golang',
  'postgresql', 'mongodb', 'redis', 'ci/cd', 'microservices',
  'data analysis', 'tableau', 'power bi', 'excel', 'financial modeling',
  'java', 'spring boot', 'c++', 'c#', '.net',
]);

const SENIOR_SIGNALS = new Set([
  'led', 'managed', 'architected', 'founded', 'director',
  'principal', 'staff', 'vp', 'head of', 'senior', 'lead',
  'chief', 'cto', 'ceo', 'president', 'manager',
]);

const DEGREE_SCORES = new Map([
  ['phd',           100],
  ['doctorate',     100],
  ['doctor',        100],
  ['md',             95],
  ['mbbs',           95],
  ['master',         85],
  ['msc',            85],
  ['mba',            85],
  ['llm',            85],
  ['bachelor',       70],
  ['bsc',            70],
  ['btech',          70],
  ['b.tech',         70],
  ['b.e',            70],
  ['ba ',            70],
  ['llb',            70],
  ['bcom',           65],
  ['b.com',          65],
  ['diploma',        50],
  ['associate',      50],
  ['certificate',    40],
  ['high school',    30],
  ['a-level',        35],
  ['o-level',        30],
]);

class ResumeScoreEngineV2 {
  get version() {
    return 'resume_score_v2.0';
  }

  /**
   * Score a HireRiseResume object.
   * Also accepts legacy raw parsed shape (will auto-normalize via safe accessors).
   *
   * @param {HireRiseResume | object} resume
   * @returns {ScoreResult}
   */
  score(resume = {}) {
    // Support both schema-aware and legacy raw shape
    const isNewSchema = resume && typeof resume.core === 'object';

    const breakdown = {
      completeness: isNewSchema
        ? this.#scoreCompletenessNew(resume)
        : this.#scoreCompletenessLegacy(resume),
      skills:       this.#scoreSkills(resume, isNewSchema),
      experience:   this.#scoreExperience(resume, isNewSchema),
      education:    this.#scoreEducation(resume, isNewSchema),
      formatting:   this.#scoreFormatting(resume, isNewSchema),
    };

    const overallScore = Math.round(
      Object.entries(breakdown).reduce(
        (sum, [dimension, score]) =>
          sum + score * (WEIGHTS[dimension] ?? 0),
        0
      )
    );

    const skillNames = isNewSchema
      ? safe.skillNames(resume)
      : (Array.isArray(resume?.skills)
          ? resume.skills.map(s => typeof s === 'string' ? s : s?.name ?? '')
          : []);

    return {
      overallScore,
      tier:          this.#mapTier(overallScore),
      breakdown,
      extractedSkills: skillNames,
      recommendations: this.#generateRecommendations(breakdown, resume, isNewSchema),
      rawData: {
        weightMap: WEIGHTS,
        version:   this.version,
        schemaAware: isNewSchema,
      },
    };
  }

  // ─── New schema scoring ────────────────────────────────────────────────────

  #scoreCompletenessNew(resume) {
    // Use pre-computed completeness from metadata
    return safe.completeness(resume);
  }

  // ─── Legacy schema scoring (backward compat) ──────────────────────────────

  #scoreCompletenessLegacy(parsed) {
    const sections = parsed?.sections ?? {};
    const REQUIRED = ['experience', 'skills', 'contact'];
    const OPTIONAL = ['education', 'summary', 'certifications', 'projects'];

    const req = REQUIRED.filter(s => (sections[s] ?? []).length > 0).length;
    const opt = OPTIONAL.filter(s => (sections[s] ?? []).length > 0).length;

    return Math.round((req / REQUIRED.length * 0.8 + opt / OPTIONAL.length * 0.2) * 100);
  }

  // ─── Skills scoring (handles both shapes) ─────────────────────────────────

  #scoreSkills(resume, isNewSchema) {
    const names = isNewSchema
      ? safe.skillNames(resume)
      : (Array.isArray(resume?.skills)
          ? resume.skills.map(s => typeof s === 'string' ? s : s?.name ?? '').filter(Boolean)
          : []);

    if (names.length === 0) return 0;

    const normalized   = names.map(s => s.toLowerCase().trim());
    const unique       = new Set(normalized);
    const highValCount = normalized.filter(s => HIGH_VALUE_SKILLS.has(s)).length;

    const countScore   = Math.min(unique.size / 20, 1);
    const qualityScore = Math.min(highValCount / 5, 1);

    return Math.round((countScore * 0.4 + qualityScore * 0.6) * 100);
  }

  // ─── Experience scoring ───────────────────────────────────────────────────

  #scoreExperience(resume, isNewSchema) {
    if (!isNewSchema) {
      // Legacy path
      const exps = resume?.sections?.experience ?? [];
      if (exps.length === 0) return 10;
      const totalYears = Number(resume?.metadata?.totalYearsExperience) || exps.length * 1.5;
      return Math.round(Math.min(totalYears / 10, 1) * 100);
    }

    const exps = safe.experience(resume);
    if (exps.length === 0) return 10;

    // Count years from date ranges
    const years = this.#estimateYearsFromExperience(exps);
    const yearsScore = Math.min(years / 10, 1);

    // Seniority from role titles
    const seniorityScore = exps.some(e => {
      const role = (e.role ?? e.title ?? '').toLowerCase();
      return [...SENIOR_SIGNALS].some(sig => role.includes(sig));
    }) ? 1 : 0.5;

    // Diversity: mix of types adds depth
    const types = new Set(exps.map(e => e.type ?? EXPERIENCE_TYPES.JOB));
    const diversityBonus = types.size > 1 ? 0.1 : 0;

    // Job count score
    const countScore = Math.min(exps.length / 4, 1);

    return Math.round(
      (yearsScore * 0.45 + seniorityScore * 0.3 + countScore * 0.2 + diversityBonus * 0.05) * 100
    );
  }

  #estimateYearsFromExperience(exps) {
    const yearRe = /\b(19|20)\d{2}\b/;
    const years = [];

    for (const e of exps) {
      const texts = [e.startDate ?? '', e.endDate ?? '', e.description ?? ''];
      for (const t of texts) {
        const m = String(t).match(/\b(19|20)\d{2}\b/g);
        if (m) years.push(...m.map(Number));
      }
    }

    if (years.length < 2) return exps.length * 1.5;
    return Math.max(...years) - Math.min(...years);
  }

  // ─── Education scoring ────────────────────────────────────────────────────

  #scoreEducation(resume, isNewSchema) {
    if (!isNewSchema) {
      const edu = resume?.sections?.education ?? [];
      if (edu.length === 0) return 30;
      let highest = 0;
      for (const e of edu) {
        const level = String(e?.degree ?? '').toLowerCase();
        for (const [keyword, points] of DEGREE_SCORES) {
          if (level.includes(keyword)) highest = Math.max(highest, points);
        }
      }
      return highest || 40;
    }

    const edu = safe.education(resume);
    if (edu.length === 0) return 30;

    let highest = 0;
    for (const e of edu) {
      const level = String(e?.degree ?? '').toLowerCase();
      for (const [keyword, points] of DEGREE_SCORES) {
        if (level.includes(keyword)) {
          highest = Math.max(highest, points);
        }
      }
    }
    return highest || 40;
  }

  // ─── Formatting / document quality scoring ────────────────────────────────

  #scoreFormatting(resume, isNewSchema) {
    if (!isNewSchema) {
      const wordCount    = Number(resume?.metadata?.wordCount) || 0;
      const lengthScore  = wordCount >= 300 && wordCount <= 1200 ? 100 : wordCount < 300 ? 40 : 70;
      const structScore  = Object.keys(resume?.sections ?? {}).length >= 4 ? 100 : 60;
      return Math.round(lengthScore * 0.6 + structScore * 0.4);
    }

    // In new schema, use parsingConfidence as proxy for document quality
    const confidence    = safe.confidence(resume);
    const sectionCount  = [
      resume.core?.summary,
      resume.experience?.length > 0,
      resume.education?.length  > 0,
      resume.skills?.length     > 0,
    ].filter(Boolean).length;

    const confidenceScore = confidence;
    const structScore     = sectionCount >= 3 ? 100 : sectionCount >= 2 ? 70 : 40;

    return Math.round(confidenceScore * 0.5 + structScore * 0.5);
  }

  // ─── Tier mapping ─────────────────────────────────────────────────────────

  #mapTier(score) {
    if (score >= 85) return 'elite';
    if (score >= 70) return 'strong';
    if (score >= 50) return 'developing';
    return 'needs_work';
  }

  // ─── Recommendations ──────────────────────────────────────────────────────

  #generateRecommendations(breakdown, resume, isNewSchema) {
    const recs = [];

    if (breakdown.completeness < 60) {
      const missing = isNewSchema ? safe.missingFields(resume) : [];
      recs.push({
        priority:  'high',
        dimension: 'completeness',
        message:   missing.length
          ? `Complete missing fields: ${missing.slice(0, 3).join(', ')}`
          : 'Add contact details and a professional summary',
      });
    }

    if (breakdown.skills < 60) {
      recs.push({
        priority:  'high',
        dimension: 'skills',
        message:   'Add more in-demand technical or domain skills (aim for 8+)',
      });
    }

    if (breakdown.experience < 60) {
      recs.push({
        priority:  'medium',
        dimension: 'experience',
        message:   'Quantify achievements with numbers and outcomes',
      });
    }

    if (breakdown.education < 50) {
      recs.push({
        priority:  'low',
        dimension: 'education',
        message:   'Add your highest qualification or any relevant certifications',
      });
    }

    if (breakdown.formatting < 60) {
      recs.push({
        priority:  'medium',
        dimension: 'formatting',
        message:   'Ensure your resume is clearly structured with distinct sections',
      });
    }

    return recs;
  }
}

module.exports = { ResumeScoreEngineV2 };