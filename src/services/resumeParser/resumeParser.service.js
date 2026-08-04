'use strict';

/**
 * WP-PRO-09N FIX:
 *
 * This file previously used ESM `import`/`export` syntax inside a package
 * that has no `"type": "module"` (the other 680+ files in src/ are all
 * CommonJS, using `require`/`module.exports`). Every consumer of this
 * module (`services/resumeParser/index.js`,
 * `modules/onboarding/controllers/onboarding.controller.js`) loads it with
 * `require(...)` and destructures `{ parseResumeText, mapParsedToOnboardingShape }`
 * — names that were never even defined here (only an unrelated `parseResume`
 * was exported, via `export`, which CommonJS `require()` cannot see at all).
 * The practical effect: `parseResumeText` and `mapParsedToOnboardingShape`
 * resolved to `undefined` everywhere they were imported, so the mature,
 * purpose-built extraction engine in `regexUtils.js` (extractName,
 * extractExperience, extractEducation, extractLocation, etc.) was never
 * actually invoked by the Resume Upload pipeline.
 *
 * This fix (a) converts the module to standard CommonJS so it can be
 * `require()`'d correctly, and (b) implements `parseResumeText` and
 * `mapParsedToOnboardingShape` by wiring together the existing regex-based
 * extractors — no new parser, no AI, no architecture change.
 */

const { createClient } = require('@supabase/supabase-js');
// Node 20 has no native global WebSocket — required by RealtimeClient at
// construction time even when realtime isn't used. See config/supabase.js.
const WebSocket = require('ws');
const logger = require('../../../shared/logger/index.js');
const regexUtils = require('./regexUtils');
const { aliasMap: SKILL_ALIAS_MAP } = require('./skillDictionary');
const { ROLE_ENTRIES } = require('./roleDictionary');

let supabaseClient = null;
const MAX_TEXT_LENGTH = 50000;
const MAX_SKILLS = 100;

function getSupabaseClient() {
  if (supabaseClient) return supabaseClient;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      'Supabase env configuration missing: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY'
    );
  }

  supabaseClient = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    realtime: {
      transport: WebSocket,
    },
    global: {
      headers: {
        'x-client-info': 'resume-worker-parser',
      },
    },
  });

  return supabaseClient;
}

/**
 * Parse resume from Supabase Storage
 */
async function parseResume(storagePath, mimeType) {
  if (!storagePath || typeof storagePath !== 'string') {
    throw new Error('Invalid storagePath');
  }

  const { text, isTruncated } = await fetchFromStorage(storagePath);
  return extractStructure(text, mimeType, isTruncated);
}

async function fetchFromStorage(storagePath) {
  const bucket = process.env.RESUME_STORAGE_BUCKET;

  if (!bucket) {
    throw new Error('RESUME_STORAGE_BUCKET env var not set');
  }

  const supabase = getSupabaseClient();

  const { data, error } = await supabase.storage
    .from(bucket)
    .download(storagePath);

  if (error) {
    logger.error('Storage fetch failed', {
      storagePath,
      bucket,
      error: error.message,
    });

    const normalizedError = new Error(
      `Storage fetch failed: ${error.message}`
    );

    normalizedError.code =
      error.statusCode === '404' ? '404' : 'STORAGE_READ_FAILED';

    throw normalizedError;
  }

  const fullText = String(await data.text());
  const isTruncated = fullText.length > MAX_TEXT_LENGTH;

  const text = isTruncated
    ? fullText.slice(0, MAX_TEXT_LENGTH)
    : fullText;

  if (isTruncated) {
    logger.warn('[ResumeWorker] Resume text truncated during storage fetch', {
      originalLength: fullText.length,
      truncatedLength: text.length,
      limit: MAX_TEXT_LENGTH,
    });
  }

  return { text, isTruncated };
}

/* =========================
   EXISTING LOGIC (UNCHANGED)
========================= */

function extractStructure(text, mimeType, isTruncated = false) {
  const safeText = String(text ?? '').slice(0, MAX_TEXT_LENGTH);

  const lines = safeText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const sections = classifySections(lines);
  const skills = extractSkills(sections.skills ?? []);

  logger.info('[ResumeWorker] sections detected', {
    sections: Object.keys(sections).reduce((acc, k) => {
      acc[k] = sections[k]?.length ?? 0;
      return acc;
    }, {}),
    skillCount: skills.length,
    hasExperience: (sections.experience?.length ?? 0) > 0,
  });

  const wordCount = safeText.trim()
    ? safeText.trim().split(/\s+/).length
    : 0;

  const totalYearsExperience = estimateYearsExperience(
    sections.experience ?? []
  );

  return {
    rawText: safeText,
    sections,
    skills,
    metadata: {
      wordCount,
      lineCount: lines.length,
      totalYearsExperience,
      mimeType: mimeType ?? 'unknown',
      parsedAt: new Date().toISOString(),
      isTruncated, // 🔥 FIX
    },
  };
}

/* =========================
   REMAINING CODE UNCHANGED
========================= */

const SECTION_HEADERS = Object.freeze({
  experience:
    /^(?:(?:work\s+|professional\s+|clinical\s+|medical\s+|hospital\s+)?experience|employment(?:\s+history)?|work\s+history|career\s+history|positions?\s+held|internships?(?:\s+experience)?|(?:compulsory\s+)?(?:rotating\s+)?internship|clinical\s+(?:work|training)|practical\s+training|industrial\s+training|field\s+training)$/i,

  education:
    /^(?:education(?:al)?(?:\s+(?:background|qualifications?|history))?|academic\s+(?:background|qualifications?|profile)|qualifications?|scholastic\s+details?)$/i,

  skills:
    /^(?:(?:technical\s+|core\s+|key\s+|professional\s+|software\s+|computer\s+|digital\s+|it\s+)?skills?(?:\s*[&]\s*(?:competencies|software|tools))?|competencies|technologies|areas?\s+of\s+expertise|expertise|abilities|tools?\s+(?:and\s+|[&]\s+)?software)$/i,

  summary:
    /^(?:(?:professional\s+|career\s+|executive\s+|profile\s+)?summary|objective|(?:professional\s+)?profile|about(?:\s+me)?|overview)$/i,

  certifications:
    /^(?:certifications?|licenses?|credentials|professional\s+development)$/i,

  projects:
    /^(?:projects?|portfolio|key\s+projects?)$/i,

  contact:
    /^(?:contact(?:\s+(?:info(?:rmation)?|details?))?|personal\s+(?:info(?:rmation)?|details?))$/i,
});

function classifySections(lines) {
  const sections = {};
  let currentSection = 'other';

  for (const line of lines) {
    let matchedSection = null;

    for (const [sectionName, pattern] of Object.entries(
      SECTION_HEADERS
    )) {
      if (pattern.test(line) && line.length < 60) {
        matchedSection = sectionName;
        break;
      }
    }

    if (matchedSection) {
      currentSection = matchedSection;
      sections[currentSection] ??= [];
      continue;
    }

    sections[currentSection] ??= [];
    sections[currentSection].push(line);
  }

  return sections;
}

function extractSkills(skillLines) {
  const normalized = new Set();
  const BULLET_RE = /^[-\u2013\u2014\u2022\u00b7*\u25ba\u25aa\u25b8]\s*/;

  for (const line of skillLines) {
    const tokens = String(line)
      .replace(BULLET_RE, '')
      .split(/[,|•·/\n]+/)
      .map((skill) => skill.trim().replace(BULLET_RE, ''))
      .filter((skill) => skill.length > 1 && skill.length < 60);

    for (const token of tokens) {
      normalized.add(token);
      if (normalized.size >= MAX_SKILLS) break;
    }

    if (normalized.size >= MAX_SKILLS) break;
  }

  return [...normalized];
}

function estimateYearsExperience(experienceLines) {
  const yearPattern = /\b(?:19|20)\d{2}\b/g;
  const years = [];

  for (const line of experienceLines) {
    const matches = String(line).match(yearPattern);
    if (matches) {
      years.push(...matches.map(Number));
    }
  }

  if (years.length < 2) return null;

  const minYear = Math.min(...years);
  const maxYear = Math.max(...years);

  return maxYear > minYear ? maxYear - minYear : null;
}

/* =========================================================================
   parseResumeText() / mapParsedToOnboardingShape()

   WP-PRO-09N: these two functions are the missing wiring layer. They were
   referenced everywhere (onboarding.controller.js, resumeParser/index.js,
   resume.normalizer.js) but never defined, so the mature extractors in
   regexUtils.js sat orphaned. Implemented here using ONLY the existing
   extraction functions — no new parser, no AI.
========================================================================= */

/**
 * Canonicalize a single raw skill token.
 *
 * WP-PRO-09N FIX: the previous behaviour (implicit — since this function
 * did not exist, nothing called the dictionary at all) would have dropped
 * any skill without an exact alias match if it had been wired up the
 * obvious way (filter-to-dictionary-hits-only). skillDictionary.js is
 * heavily biased toward software-engineering terms (JavaScript, TypeScript,
 * Docker, Kubernetes, ...) with only one marketing entry ("SEO"), so a
 * naive dictionary-filter approach would silently discard legitimate,
 * resume-declared skills like "Digital Marketing", "Brand Strategy",
 * "Content Marketing", "CRM", "Email Marketing", "Social Media", and
 * "Analytics" for any non-tech resume.
 *
 * This function instead uses the dictionary ONLY to canonicalize known
 * aliases (e.g. "js" → "JavaScript"); any token that isn't a recognised
 * alias is kept as-is (trimmed) rather than discarded, so real,
 * resume-declared skills are never silently dropped.
 *
 * @param {string} rawSkill
 * @returns {string|null}
 */
function canonicalizeSkill(rawSkill) {
  const trimmed = String(rawSkill ?? '').trim();
  if (!trimmed) return null;

  const alias = SKILL_ALIAS_MAP.get(trimmed.toLowerCase());
  if (alias) return alias.canonical;

  return trimmed;
}

/**
 * Detect candidate roles from the full resume text via keyword scoring.
 * Used ONLY as a last-resort title fallback when the experience section is
 * empty (see resume.normalizer.js — experience section title always wins).
 *
 * @param {string} textLower
 * @returns {string[]} canonical role names, best match first
 */
function detectRoles(textLower) {
  const scored = ROLE_ENTRIES
    .map((entry) => ({
      canonical: entry.canonical,
      score: entry.keywords.filter((kw) => textLower.includes(kw)).length,
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.map((r) => r.canonical);
}

/**
 * Rough parse-confidence heuristic (0–1), used for
 * HireRiseResume.metadata.parsingConfidence.
 */
function computeConfidenceScore({ email, skills, experience }) {
  let score = 0;
  if (email) score += 0.34;
  if (skills.length >= 3) score += 0.33;
  if (experience.length >= 1) score += 0.33;
  return Math.round(score * 100) / 100;
}

/**
 * Parse raw resume text into a flat, deterministic structure using the
 * existing regexUtils.js extractors. This is the function
 * `services/resumeParser/index.js` has always claimed to export.
 *
 * @param {string} resumeText
 * @returns {object} raw parsed resume (consumed by mapParsedToOnboardingShape
 *   and by resume.normalizer.js's normalizeFromParsed)
 */
function parseResumeText(resumeText) {
  const safeText = String(resumeText ?? '').slice(0, MAX_TEXT_LENGTH);

  const lines = safeText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  // Section-bucketed lines — used only for the Skills section, since
  // extractExperience/extractEducation do their own header-detection over
  // the full text.
  const sections = classifySections(lines);

  const rawSkillTokens = extractSkills(sections.skills ?? []);
  const skills = [...new Set(
    rawSkillTokens
      .map(canonicalizeSkill)
      .filter(Boolean)
  )];

  const experience = regexUtils.extractExperience(safeText);
  const education = regexUtils.extractEducation(safeText);
  const location = regexUtils.extractLocation(safeText);
  const name = regexUtils.extractName(safeText);
  const email = regexUtils.extractEmail(safeText);
  const phone = regexUtils.extractPhone(safeText);
  const yearsOfExperience = regexUtils.extractYearsOfExperience(safeText);

  const textLower = safeText.toLowerCase();
  const detectedRoles = detectRoles(textLower);

  const professionalSummaryLines = sections.summary ?? [];
  const professionalSummary = professionalSummaryLines.length
    ? professionalSummaryLines.join(' ').slice(0, 600)
    : null;

  const certifications = sections.certifications ?? [];

  logger.info('[ResumeParser] parseResumeText complete', {
    hasName: !!name,
    hasEmail: !!email,
    skillCount: skills.length,
    experienceCount: experience.length,
    educationCount: education.length,
  });

  return {
    rawText: safeText,
    name,
    email,
    phone,
    location,
    professionalSummary,
    skills,
    experience,
    education,
    certifications,
    detectedRoles,
    industry: regexUtils.extractIndustry(safeText),
    educationLevel: regexUtils.extractEducationLevel(safeText),
    yearsOfExperience,
    confidenceScore: computeConfidenceScore({ email, skills, experience }),
    parsedAt: new Date().toISOString(),
  };
}

/**
 * Reshape parseResumeText() output into the "onboarding shape" consumed by
 * resume.normalizer.js's normalizeFromOnboardingShape(). Pure reshaping —
 * no re-parsing, no new field derivation beyond what parseResumeText already
 * produced.
 *
 * @param {object} parsed - output of parseResumeText()
 * @returns {object} onboardingShape
 */
function mapParsedToOnboardingShape(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return {
      personalDetails: {},
      skills: [],
      parsedResume: { experience: [], education: [], certifications: [] },
    };
  }

  return {
    personalDetails: {
      fullName: parsed.name ?? null,
      email: parsed.email ?? null,
      phone: parsed.phone ?? null,
      city: parsed.location?.city ?? null,
      country: parsed.location?.country ?? null,
      professionalSummary: parsed.professionalSummary ?? null,
    },
    skills: parsed.skills ?? [],
    parsedResume: {
      experience: parsed.experience ?? [],
      education: parsed.education ?? [],
      certifications: parsed.certifications ?? [],
    },
  };
}

module.exports = {
  parseResume,
  parseResumeText,
  mapParsedToOnboardingShape,
  // exported for tests / reuse
  classifySections,
  extractSkills,
  estimateYearsExperience,
  canonicalizeSkill,
  detectRoles,
};