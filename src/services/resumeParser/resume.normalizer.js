'use strict';

/**
 * @file services/resumeParser/resume.normalizer.js
 *
 * HireRise Resume Normalizer — v1
 *
 * Converts the raw output of parseResumeText() + mapParsedToOnboardingShape()
 * into a fully-structured HireRise Resume object.
 *
 * This is a PURE function layer — no I/O, no DB, no HTTP.
 * Drop it anywhere in the pipeline.
 *
 * WHAT IT HANDLES:
 *  - Maps personal details → core
 *  - Classifies experience entries as job / internship / project
 *  - Maps certifications → additionalSections
 *  - Maps education to structured objects with startYear/endYear
 *  - Maps skills to { name } objects
 *  - Computes parsingConfidence and completenessScore
 *  - Detects professional domain (tech, healthcare, finance, etc.)
 *  - Provides safe fallbacks for every field
 *
 * BACKWARD COMPATIBILITY:
 *  - Accepts old frontend shape (personal_info, skills: string[], etc.)
 *  - Accepts new onboardingShape from mapParsedToOnboardingShape()
 *  - Accepts raw parseResumeText() output
 *  - All three paths produce the same HireRiseResume output
 */

const crypto = require('crypto');
const {
  emptyResume,
  computeMetadata,
  EXPERIENCE_TYPES,
} = require('../../shared/hirerise-resume.schema');

// ─── Experience Type Classification ──────────────────────────────────────────

const INTERNSHIP_SIGNALS = [
  'intern', 'internship', 'trainee', 'apprentice', 'attachment',
  'industrial training', 'work placement', 'placement student',
  'summer analyst', 'co-op', 'coop', 'co op',
];

const PROJECT_SIGNALS = [
  'project', 'freelance', 'freelancer', 'independent',
  'open source', 'side project', 'personal project',
  'contract', 'consulting', 'consultant', 'self-employed',
  'volunteer', 'pro bono',
];

/**
 * Classify an experience entry as 'job' | 'internship' | 'project'.
 * @param {{ title?: string, company?: string, description?: string }} entry
 * @returns {'job' | 'internship' | 'project'}
 */
function classifyExperienceType(entry) {
  const haystack = [
    entry.title       ?? '',
    entry.company     ?? '',
    entry.description ?? '',
    entry.role        ?? '',
  ].join(' ').toLowerCase();

  if (INTERNSHIP_SIGNALS.some(s => haystack.includes(s))) {
    return EXPERIENCE_TYPES.INTERNSHIP;
  }
  if (PROJECT_SIGNALS.some(s => haystack.includes(s))) {
    return EXPERIENCE_TYPES.PROJECT;
  }
  return EXPERIENCE_TYPES.JOB;
}

// ─── Domain Detection ─────────────────────────────────────────────────────────

const DOMAIN_SIGNALS = [
  { domain: 'software_engineering',  keywords: ['software', 'developer', 'engineer', 'frontend', 'backend', 'fullstack', 'devops', 'typescript', 'react', 'node', 'python', 'java', 'golang'] },
  { domain: 'data_science',          keywords: ['data scientist', 'machine learning', 'deep learning', 'nlp', 'data analyst', 'analytics', 'tensorflow', 'pytorch', 'pandas', 'spark'] },
  { domain: 'healthcare',            keywords: ['doctor', 'physician', 'nurse', 'clinical', 'hospital', 'patient', 'medical', 'surgery', 'mbbs', 'md', 'healthcare', 'pharma', 'pharmacist'] },
  { domain: 'finance_accounting',    keywords: ['accountant', 'accounting', 'finance', 'auditor', 'cpa', 'cfa', 'acca', 'cma', 'tax', 'bookkeeping', 'financial analyst', 'treasury'] },
  { domain: 'marketing',             keywords: ['marketing', 'brand', 'seo', 'content', 'social media', 'campaign', 'growth', 'copywriter', 'advertising', 'pr', 'public relations'] },
  { domain: 'design',                keywords: ['designer', 'ui', 'ux', 'figma', 'sketch', 'adobe', 'graphic', 'visual', 'creative', 'illustrator', 'photoshop', 'product design'] },
  { domain: 'law',                   keywords: ['lawyer', 'attorney', 'barrister', 'solicitor', 'legal', 'paralegal', 'litigation', 'counsel', 'llb', 'llm', 'juris'] },
  { domain: 'education',             keywords: ['teacher', 'lecturer', 'professor', 'educator', 'curriculum', 'tutor', 'academic', 'pedagogy', 'school', 'university', 'b.ed'] },
  { domain: 'sales',                 keywords: ['sales', 'account executive', 'business development', 'bd', 'crm', 'salesforce', 'revenue', 'quota', 'pipeline', 'prospecting'] },
  { domain: 'hr_people_ops',         keywords: ['human resources', 'hr', 'talent', 'recruiter', 'recruitment', 'people ops', 'hris', 'payroll', 'l&d', 'learning and development'] },
  { domain: 'engineering_non_software', keywords: ['civil', 'mechanical', 'electrical', 'chemical engineer', 'structural', 'autocad', 'cad', 'manufacturing', 'production'] },
];

/**
 * Detect a professional domain from the full text.
 * Returns the best-matching domain string, or null.
 */
function detectDomain(textLower = '') {
  let best = null;
  let bestScore = 0;

  for (const { domain, keywords } of DOMAIN_SIGNALS) {
    const score = keywords.filter(kw => textLower.includes(kw)).length;
    if (score > bestScore) {
      bestScore = score;
      best = domain;
    }
  }

  return bestScore >= 2 ? best : null;
}

// ─── Section-based Extraction (handles DOCX multi-line blocks) ───────────────

/**
 * Extract text between a section header and the next major header.
 * Handles both "SECTION\nContent" and "Section: Content" patterns.
 *
 * @param {string} text - full resume text
 * @param {string[]} headerAliases - e.g. ['certifications', 'licenses']
 * @param {string[]} stopHeaders - headers that end this section
 * @returns {string[]} - lines belonging to this section
 */
function extractSectionLines(text, headerAliases, stopHeaders) {
  const lines = text.split(/\r?\n/).map(l => l.trim());
  const aliasSet = new Set(headerAliases.map(a => a.toLowerCase()));
  const stopSet  = new Set(stopHeaders.map(s => s.toLowerCase()));

  let inSection = false;
  const result  = [];

  for (const line of lines) {
    if (!line) continue;
    const lower = line.toLowerCase().replace(/:$/, '').trim();

    if (aliasSet.has(lower)) {
      inSection = true;
      continue;
    }

    if (inSection && stopSet.has(lower)) {
      break;
    }

    if (inSection) {
      result.push(line);
    }
  }

  return result;
}

const CERT_SECTION_ALIASES = [
  'certifications', 'certification', 'licenses', 'credentials',
  'professional certifications', 'awards & certifications',
  'licences', 'licenses & certifications',
];

const SECTION_STOP_HEADERS = [
  'experience', 'work experience', 'employment', 'education',
  'skills', 'projects', 'summary', 'objective', 'references',
  'languages', 'awards', 'publications', 'contact',
];

// ─── Normalizer: fromParsed ───────────────────────────────────────────────────

/**
 * Normalize the raw output of parseResumeText() into a HireRiseResume.
 *
 * @param {object} parsed - output of parseResumeText()
 * @param {string} resumeId
 * @param {string} userId
 * @returns {HireRiseResume}
 */
function normalizeFromParsed(parsed, resumeId, userId) {
  const resume = emptyResume(resumeId, userId);

  // ── core ─────────────────────────────────────────────────────────────────
  const loc = parsed?.location;
  const locationStr = [loc?.city, loc?.country].filter(Boolean).join(', ') || null;

  // ── skills ───────────────────────────────────────────────────────────────
  resume.skills = (parsed?.skills ?? [])
    .slice(0, 60)
    .map(name => ({ name: String(name).trim() }))
    .filter(s => s.name.length > 0);

  // ── experience (built BEFORE core so core.title can use [0].role) ────────
  resume.experience = (parsed?.experience ?? []).map((e, i) => {
    const entry = {
      role:        e.title       ?? e.role      ?? '',
      company:     e.company     ?? '',
      startDate:   e.start_date  ?? e.startDate ?? null,
      endDate:     e.end_date    ?? e.endDate   ?? null,
      current:     !e.end_date   && !e.endDate,
      description: e.description ?? null,
      type:        classifyExperienceType(e),
    };
    return entry;
  });

  // ── core (title: experience section ALWAYS wins over keyword detection) ──
  //
  // Priority: experience[0].title  →  experience[0].role  →  detectedRoles[0]
  //
  // detectedRoles is a keyword-frequency score over the whole document and can
  // match generic terms (e.g. "accounts" → Accountant) that override a very
  // specific job title like "Junior Resident Doctor".  We therefore only fall
  // back to detectedRoles when the experience section is empty.
  const experienceTitleSource =
    parsed?.experience?.[0]?.title ??
    parsed?.experience?.[0]?.role  ??
    null;

  const resolvedTitle =
    experienceTitleSource ||          // ← primary: actual experience section
    (parsed?.experience?.length       // ← safety guard: if exp exists, stop here
      ? null
      : parsed?.detectedRoles?.[0] ?? null);  // ← last resort: keyword match

  /* DEBUG – remove before go-live */
  if (process.env.RESUME_PARSER_DEBUG === 'true') {
    console.debug('[normalizeFromParsed] detectedRoles:', parsed?.detectedRoles);
    console.debug('[normalizeFromParsed] experience[0]:', parsed?.experience?.[0]);
    console.debug('[normalizeFromParsed] resolvedTitle:', resolvedTitle);
  }

  resume.core = {
    fullName: parsed?.name    ?? '',
    email:    parsed?.email   ?? null,
    phone:    parsed?.phone   ?? null,
    location: locationStr,
    title:    resolvedTitle,
    summary:  parsed?.professionalSummary ?? null,
  };

  // ── education ────────────────────────────────────────────────────────────
  resume.education = (parsed?.education ?? []).map((e) => {
    if (typeof e === 'string') {
      return { degree: e, institution: '', startYear: null, endYear: null };
    }
    return {
      degree:      e.degree      ?? e.qualification ?? '',
      institution: e.institution ?? e.school        ?? '',
      startYear:   e.startYear   ?? null,
      endYear:     e.endYear     ?? null,
    };
  });

  // ── additionalSections: certifications ───────────────────────────────────
  const certs = parsed?.certifications ?? [];
  if (certs.length > 0) {
    resume.additionalSections.push({
      title: 'Certifications',
      items: certs.map(c => (typeof c === 'string' ? { name: c } : c)),
    });
  }

  // ── metadata ─────────────────────────────────────────────────────────────
  const domain = detectDomain([
    resume.core.fullName,
    resume.core.title,
    resume.core.summary,
    ...resume.skills.map(s => s.name),
    ...resume.experience.map(e => `${e.role} ${e.company} ${e.description ?? ''}`),
  ].join(' ').toLowerCase());

  const { missingFields, completenessScore } = computeMetadata(resume);

  resume.metadata = {
    parsingConfidence:  parsed?.confidenceScore ?? 0,
    completenessScore,
    missingFields,
    detectedDomain:     domain,
    schemaVersion:      '1.0.0',
    parsedAt:           parsed?.parsedAt ?? new Date().toISOString(),
  };

  return resume;
}

// ─── Normalizer: fromOnboardingShape ─────────────────────────────────────────

/**
 * Normalize from the output of mapParsedToOnboardingShape().
 * Used when you already have the onboardingShape (avoids double-parsing).
 *
 * @param {object} parsed         - raw parseResumeText() output
 * @param {object} onboardingShape - mapParsedToOnboardingShape() output
 * @param {string} resumeId
 * @param {string} userId
 * @returns {HireRiseResume}
 */
function normalizeFromOnboardingShape(parsed, onboardingShape, resumeId, userId) {
  const resume = emptyResume(resumeId, userId);

  // ── core ─────────────────────────────────────────────────────────────────
  const pd = onboardingShape?.personalDetails ?? {};
  const locationStr = [pd.city, pd.country].filter(Boolean).join(', ') || null;

  // ── skills ───────────────────────────────────────────────────────────────
  resume.skills = (onboardingShape?.skills ?? [])
    .slice(0, 60)
    .map(s => ({ name: typeof s === 'string' ? s : (s?.name ?? '') }))
    .filter(s => s.name.length > 0);

  // ── experience (built BEFORE core so core.title can read [0].role) ───────
  //
  // Do NOT synthesize a fake experience entry from detectedRoles — that is what
  // caused "Accountant" to appear for a doctor whose CV had real experience entries.
  // If the experience section is empty we leave it empty; the caller can decide
  // whether to ask the user to fill it in.
  const rawExp = onboardingShape?.parsedResume?.experience ?? [];
  resume.experience = rawExp.map(e => ({
    role:        e.title       ?? e.role      ?? '',
    company:     e.company     ?? '',
    startDate:   e.start_date  ?? e.startDate ?? null,
    endDate:     e.end_date    ?? e.endDate   ?? null,
    current:     (!e.end_date && !e.endDate),
    description: e.description ?? null,
    type:        classifyExperienceType(e),
  }));

  // ── core (title: experience section ALWAYS wins over keyword detection) ──
  //
  // Priority: onboardingShape experience[0].title
  //        →  onboardingShape experience[0].role
  //        →  parsed.experience[0].title  (raw parser, belt-and-suspenders)
  //        →  detectedRoles[0]  ONLY when no experience exists at all
  //
  // detectedRoles is a keyword-frequency scorer over the whole document and can
  // fire on incidental words (e.g. "accounts receivable" → Accountant).
  // We must never let it override a real job title.
  const expTitleSource =
    onboardingShape?.parsedResume?.experience?.[0]?.title ??
    onboardingShape?.parsedResume?.experience?.[0]?.role  ??
    parsed?.experience?.[0]?.title                        ??
    parsed?.experience?.[0]?.role                         ??
    null;

  const hasExperience =
    (onboardingShape?.parsedResume?.experience?.length ?? 0) > 0 ||
    (parsed?.experience?.length ?? 0) > 0;

  const resolvedTitle =
    expTitleSource ||
    (hasExperience ? null : (parsed?.detectedRoles?.[0] ?? null));

  /* DEBUG – remove before go-live */
  if (process.env.RESUME_PARSER_DEBUG === 'true') {
    console.debug('[normalizeFromOnboardingShape] detectedRoles:', parsed?.detectedRoles);
    console.debug('[normalizeFromOnboardingShape] onboardingShape.parsedResume.experience:',
      onboardingShape?.parsedResume?.experience);
    console.debug('[normalizeFromOnboardingShape] structuredResume.experience:',
      resume.experience);
    console.debug('[normalizeFromOnboardingShape] resolvedTitle:', resolvedTitle);
    console.log('ONBOARDING SHAPE:', JSON.stringify(onboardingShape, null, 2));
  }

  resume.core = {
    fullName: pd.fullName ?? '',
    email:    pd.email    ?? null,
    phone:    pd.phone    ?? null,
    location: locationStr,
    title:    resolvedTitle,
    summary:  pd.professionalSummary    ?? null,
  };

  // ── education ────────────────────────────────────────────────────────────
  // Guard: the regex parser occasionally places internship entries into the
  // education array when the CV has no clear section boundary.  We filter
  // them out here so they stay in experience[] and not education[].
  const INTERNSHIP_DEGREE_SIGNALS = [
    'intern', 'internship', 'industrial training', 'rotating',
    'compulsory', 'practical training', 'clinical training',
    'field training', 'attachment', 'placement',
  ];
  const rawEdu = onboardingShape?.parsedResume?.education ?? [];
  const internshipBleeds = []; // entries that look like internships, not degrees

  resume.education = rawEdu
    .filter(e => {
      if (typeof e === 'string') return true; // strings are degree lines — keep
      const degreeText = (e.degree ?? '').toLowerCase();
      const isInternship = INTERNSHIP_DEGREE_SIGNALS.some(sig => degreeText.includes(sig));
      if (isInternship) {
        // Rescue: push to experience instead
        internshipBleeds.push(e);
        return false;
      }
      return true;
    })
    .map(e => {
      if (typeof e === 'string') {
        return { degree: e, institution: '', startYear: null, endYear: null };
      }
      return {
        degree:      e.degree      ?? '',
        institution: e.institution ?? '',
        startYear:   e.startYear   ?? null,
        endYear:     e.endYear     ?? null,
      };
    });

  // Rescue any internship entries that were mis-classified as education
  if (internshipBleeds.length > 0) {
    const rescued = internshipBleeds.map(e => ({
      role:        e.degree      ?? 'Internship',
      company:     e.institution ?? '',
      startDate:   e.startYear   ?? null,
      endDate:     e.endYear     ?? null,
      current:     false,
      description: null,
      type:        EXPERIENCE_TYPES.INTERNSHIP,
    }));
    // Prepend rescued entries only if they're not already in experience[]
    const existingTitles = new Set(resume.experience.map(x => x.role.toLowerCase()));
    for (const r of rescued) {
      if (!existingTitles.has(r.role.toLowerCase())) {
        resume.experience.push(r);
      }
    }
  }

  // ── additionalSections ───────────────────────────────────────────────────
  const certs = onboardingShape?.parsedResume?.certifications ?? [];
  if (certs.length > 0) {
    resume.additionalSections.push({
      title: 'Certifications',
      items: certs.map(c => (typeof c === 'string' ? { name: c } : c)),
    });
  }

  // ── metadata ─────────────────────────────────────────────────────────────
  const domain = detectDomain([
    resume.core.fullName,
    resume.core.title,
    resume.core.summary,
    ...resume.skills.map(s => s.name),
  ].join(' ').toLowerCase());

  const { missingFields, completenessScore } = computeMetadata(resume);

  resume.metadata = {
    parsingConfidence:  parsed?.confidenceScore ?? 0,
    completenessScore,
    missingFields,
    detectedDomain:     domain,
    schemaVersion:      '1.0.0',
    parsedAt:           parsed?.parsedAt ?? new Date().toISOString(),
  };

  /* DEBUG – remove before go-live */
  if (process.env.RESUME_PARSER_DEBUG === 'true') {
    console.log('STRUCTURED RESUME:', JSON.stringify({
      email:      resume.core.email,
      skillCount: resume.skills.length,
      skills:     resume.skills.map(s => s.name),
      experience: resume.experience,
      education:  resume.education,
    }, null, 2));
  }

  return resume;
}

// ─── Normalizer: fromFrontendShape (backward compat) ─────────────────────────

/**
 * Normalize the OLD frontend ResumeData shape into HireRiseResume.
 * Used for existing saved onboarding data (personal_info, skills: string[], etc.)
 *
 * @param {object} frontendData - { personal_info, summary, skills, experience, education, projects, certifications }
 * @param {string} resumeId
 * @param {string} userId
 * @returns {HireRiseResume}
 */
function normalizeFromFrontendShape(frontendData, resumeId, userId) {
  const resume = emptyResume(resumeId, userId);

  // ── core ─────────────────────────────────────────────────────────────────
  const pi = frontendData?.personal_info ?? {};
  resume.core = {
    fullName: pi.name     ?? '',
    email:    pi.email    ?? null,
    phone:    pi.phone    ?? null,
    location: pi.location ?? null,
    title:    null,
    summary:  frontendData?.summary ?? null,
  };

  // ── skills ───────────────────────────────────────────────────────────────
  const rawSkills = frontendData?.skills ?? [];
  resume.skills = rawSkills
    .map(s => ({ name: typeof s === 'string' ? s : (s?.name ?? '') }))
    .filter(s => s.name.length > 0);

  // ── experience ───────────────────────────────────────────────────────────
  resume.experience = (frontendData?.experience ?? []).map(e => ({
    role:        e.title       ?? '',
    company:     e.company     ?? '',
    startDate:   e.start_date  ?? null,
    endDate:     e.end_date    ?? null,
    current:     e.end_date === 'Present' || (!e.end_date),
    description: e.description ?? null,
    type:        classifyExperienceType(e),
  }));

  // ── education ────────────────────────────────────────────────────────────
  resume.education = (frontendData?.education ?? []).map(e => ({
    degree:      e.degree      ?? '',
    institution: e.institution ?? '',
    startYear:   null,
    endYear:     e.year        ?? null,
  }));

  // ── additionalSections ───────────────────────────────────────────────────
  const certs = frontendData?.certifications ?? [];
  if (certs.length > 0) {
    resume.additionalSections.push({
      title: 'Certifications',
      items: certs.map(c => (typeof c === 'string' ? { name: c } : c)),
    });
  }

  const projects = frontendData?.projects ?? [];
  if (projects.length > 0) {
    resume.additionalSections.push({
      title: 'Projects',
      items: projects.map(p => (typeof p === 'string' ? { name: p } : p)),
    });
  }

  // ── metadata ─────────────────────────────────────────────────────────────
  const { missingFields, completenessScore } = computeMetadata(resume);

  resume.metadata = {
    parsingConfidence:  completenessScore,   // no parser confidence for manual data
    completenessScore,
    missingFields,
    detectedDomain:     null,
    schemaVersion:      '1.0.0',
    parsedAt:           new Date().toISOString(),
  };

  return resume;
}

// ─── Normalizer: fromHireRiseResume (pass-through guard) ─────────────────────

/**
 * If the data is already a HireRiseResume (has resume.core), pass it through.
 * Otherwise auto-detect shape and normalize.
 *
 * @param {any} data
 * @param {string} resumeId
 * @param {string} userId
 * @returns {HireRiseResume}
 */
function normalizeAny(data, resumeId, userId) {
  if (!data || typeof data !== 'object') {
    return emptyResume(resumeId, userId);
  }

  // Already in HireRise schema
  if (data.core && typeof data.core === 'object') {
    return data;
  }

  // Old frontend shape
  if ('personal_info' in data) {
    return normalizeFromFrontendShape(data, resumeId, userId);
  }

  // Raw parseResumeText() output
  if ('confidenceScore' in data || 'detectedRoles' in data) {
    return normalizeFromParsed(data, resumeId, userId);
  }

  // Fallback: treat as frontend shape
  return normalizeFromFrontendShape(data, resumeId, userId);
}

// ─── HireRise → Frontend Shape adapter (for onboarding page backward compat) ──

/**
 * Convert a HireRiseResume back to the legacy frontend ResumeData shape.
 * Used so the existing onboarding page can continue to work without changes
 * until its own migration is complete.
 *
 * @param {HireRiseResume} resume
 * @returns {ResumeData}  (legacy frontend type)
 */
function toFrontendShape(resume) {
  const certs = (resume.additionalSections ?? [])
    .find(s => s.title === 'Certifications')?.items ?? [];
  const projects = (resume.additionalSections ?? [])
    .find(s => s.title === 'Projects')?.items ?? [];

  return {
    personal_info: {
      name:     resume.core?.fullName  ?? '',
      email:    resume.core?.email     ?? '',
      phone:    resume.core?.phone     ?? '',
      location: resume.core?.location  ?? '',
    },
    summary:        resume.core?.summary ?? '',
    skills:         (resume.skills ?? []).map(s => s.name ?? s),
    experience:     (resume.experience ?? []).map((e, i) => ({
      id:          `exp-${i}-${Date.now()}`,
      title:       e.role        ?? '',
      company:     e.company     ?? '',
      start_date:  e.startDate   ?? '',
      end_date:    e.endDate     ?? '',
      description: e.description ?? '',
    })),
    education:      (resume.education ?? []).map((e, i) => ({
      id:          `edu-${i}`,
      degree:      e.degree      ?? '',
      institution: e.institution ?? '',
      year:        e.endYear     ?? '',
    })),
    certifications: certs.map(c => (typeof c === 'string' ? c : c.name ?? '')),
    projects:       projects.map(p => (typeof p === 'string' ? p : p.name ?? '')),
  };
}

module.exports = Object.freeze({
  normalizeFromParsed,
  normalizeFromOnboardingShape,
  normalizeFromFrontendShape,
  normalizeAny,
  toFrontendShape,
  classifyExperienceType,
  detectDomain,
  extractSectionLines,
  CERT_SECTION_ALIASES,
  SECTION_STOP_HEADERS,
});