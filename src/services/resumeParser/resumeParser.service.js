'use strict';

/**
 * services/resumeParser/resumeParser.service.js
 *
 * Deterministic, zero-external-cost resume parsing engine.
 * Fully infrastructure-agnostic and optimized for Supabase JSONB pipelines.
 */

const { aliasMap } = require('./skillDictionary');
const { ROLE_ENTRIES } = require('./roleDictionary');
const {
  extractEmail,
  extractPhone,
  extractLinkedIn,
  extractPortfolio,
  extractName,
  extractLocation,
  extractYearsOfExperience,
  extractEducation,
  extractIndustry,
  extractEducationLevel,
} = require('./regexUtils');

const PARSER_VERSION = '2.0.0';

// ───────────────────────────────────────────────────────────────────────────────
// Skill Detection
// ───────────────────────────────────────────────────────────────────────────────

function detectSkills(input) {
  const text = typeof input === 'string' ? input : '';
  const lower = ` ${text.toLowerCase()} `;
  const found = new Map();

  for (const [alias, { canonical, category }] of aliasMap) {
    const normalizedAlias = alias.trim();
    if (!normalizedAlias) continue;

    const isShort = normalizedAlias.length <= 3;
    let matched = false;

    if (isShort) {
      const boundaryRegex = new RegExp(
        `(^|[^a-zA-Z0-9])${escapeRegex(normalizedAlias)}([^a-zA-Z0-9]|$)`,
        'i'
      );
      matched = boundaryRegex.test(lower);
    } else {
      matched = lower.includes(normalizedAlias);
    }

    if (matched && !found.has(canonical)) {
      found.set(canonical, category);
    }
  }

  return [...found.entries()]
    .sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]))
    .map(([canonical]) => canonical);
}

// ───────────────────────────────────────────────────────────────────────────────
// Role Detection
// ───────────────────────────────────────────────────────────────────────────────

function detectRoles(input, maxRoles = 3) {
  const lower = typeof input === 'string' ? input.toLowerCase() : '';
  const scored = [];

  for (const entry of ROLE_ENTRIES) {
    let score = 0;

    for (const keyword of entry.keywords) {
      if (lower.includes(keyword)) score++;
    }

    if (score > 0) {
      scored.push({
        role: entry.canonical,
        score,
      });
    }
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxRoles)
    .map(item => item.role);
}

// ───────────────────────────────────────────────────────────────────────────────
// Summary Extraction
// ───────────────────────────────────────────────────────────────────────────────

const SUMMARY_HEADERS = new Set([
  'professional summary',
  'career summary',
  'executive summary',
  'profile summary',
  'summary',
  'about me',
  'professional profile',
  'career objective',
  'objective',
  'profile',
  'overview',
]);

const NEXT_SECTION_HEADERS = new Set([
  'experience',
  'education',
  'skills',
  'work history',
  'employment',
  'projects',
  'certifications',
  'awards',
  'languages',
  'references',
  'contact',
]);

function extractSummary(input) {
  const text = typeof input === 'string' ? input : '';
  const lines = text.split('\n').map(line => line.trim());

  for (let i = 0; i < lines.length; i++) {
    const header = lines[i].toLowerCase().replace(/:$/, '');

    if (!SUMMARY_HEADERS.has(header)) continue;

    const summaryLines = [];

    for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
      const candidate = lines[j].toLowerCase().replace(/:$/, '');

      if (NEXT_SECTION_HEADERS.has(candidate)) break;
      if (lines[j]) summaryLines.push(lines[j]);
      if (summaryLines.length >= 6) break;
    }

    const summary = summaryLines.join(' ').trim();
    if (summary.length >= 20) {
      return summary.slice(0, 500);
    }
  }

  return null;
}

// ───────────────────────────────────────────────────────────────────────────────
// Certifications
// ───────────────────────────────────────────────────────────────────────────────

const CERT_PATTERNS = [
  /\bAWS\s+Certified\s+[\w\s]+/gi,
  /\bGoogle\s+Certified\s+[\w\s]+/gi,
  /\bMicrosoft\s+Certified[\w\s:]+/gi,
  /\bCPA\b/g,
  /\bCFA\b/g,
  /\bCISSP\b/gi,
  /\bPMP\b/g,
  /\bPRINCE2\b/gi,
  /\bCEH\b/g,
  /\bOSCP\b/gi,
  /\bCSM\b/gi,
  /\bCMA\b/g,
  /\bACCA\b/g,
];

function extractCertifications(input) {
  const text = typeof input === 'string' ? input : '';
  const found = new Set();

  for (const pattern of CERT_PATTERNS) {
    const matches = text.match(pattern) || [];
    for (const match of matches) {
      found.add(match.trim());
    }
  }

  return [...found];
}

// ───────────────────────────────────────────────────────────────────────────────
// Confidence
// ───────────────────────────────────────────────────────────────────────────────

function computeConfidence(parsed) {
  let score = 0;

  if (parsed.name) score += 15;
  if (parsed.email) score += 15;
  if (parsed.phone) score += 5;
  if (parsed.location?.city || parsed.location?.country) score += 5;

  if (parsed.skills.length >= 5) score += 20;
  else if (parsed.skills.length >= 2) score += 10;
  else if (parsed.skills.length >= 1) score += 5;

  if (parsed.yearsExperience !== null) score += 10;
  if (parsed.education.length) score += 10;
  if (parsed.detectedRoles.length) score += 5;
  if (parsed.professionalSummary) score += 5;
  if (parsed.linkedInUrl) score += 5;

  return Math.min(score, 100);
}

// ───────────────────────────────────────────────────────────────────────────────
// Main Parse
// ───────────────────────────────────────────────────────────────────────────────

function parseResumeText(resumeText) {
  if (typeof resumeText !== 'string' || !resumeText.trim()) {
    return emptyResult('Invalid or empty resume text');
  }

  const text = resumeText.trim();

  if (text.length < 30) {
    return emptyResult('Resume text too short');
  }

  const parsed = {
    name: extractName(text),
    email: extractEmail(text),
    phone: extractPhone(text),
    linkedInUrl: extractLinkedIn(text),
    portfolioUrl: extractPortfolio(text),
    location: extractLocation(text),
    skills: detectSkills(text),
    detectedRoles: detectRoles(text),
    yearsExperience: extractYearsOfExperience(text),
    education: extractEducation(text),
    certifications: extractCertifications(text),
    professionalSummary: extractSummary(text),
    industry: extractIndustry(text),
    educationLevel: extractEducationLevel(text),
    confidenceScore: 0,
    needsAIParsing: false,
    parserVersion: PARSER_VERSION,
    parsedAt: new Date().toISOString(),
  };

  parsed.confidenceScore = computeConfidence(parsed);
  parsed.needsAIParsing = parsed.confidenceScore < 50;

  return parsed;
}

// ───────────────────────────────────────────────────────────────────────────────
// Storage-safe Mapper (Supabase JSONB ready)
// ───────────────────────────────────────────────────────────────────────────────

function mapParsedToOnboardingShape(parsed) {
  return {
    personalDetails: {
      fullName: parsed?.name ?? null,
      email: parsed?.email ?? null,
      phone: parsed?.phone ?? null,
      city: parsed?.location?.city ?? null,
      country: parsed?.location?.country ?? null,
      linkedInUrl: parsed?.linkedInUrl ?? null,
      portfolioUrl: parsed?.portfolioUrl ?? null,
      languages: [],
      professionalSummary: parsed?.professionalSummary ?? null,
    },

    skills: (parsed?.skills || []).slice(0, 30).map(name => ({
      name,
      proficiency: 'intermediate',
    })),

    parsedResume: {
      education: parsed?.education || [],
      certifications: parsed?.certifications || [],
      detectedRoles: parsed?.detectedRoles || [],
      yearsExperience: parsed?.yearsExperience ?? null,
      confidenceScore: parsed?.confidenceScore ?? 0,
      needsAIParsing: parsed?.needsAIParsing ?? true,
      parserVersion: parsed?.parserVersion ?? PARSER_VERSION,
      parsedAt: parsed?.parsedAt ?? new Date().toISOString(),
      industry: parsed?.industry ?? null,
      educationLevel: parsed?.educationLevel ?? null,
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────────

function emptyResult(reason) {
  return {
    name: null,
    email: null,
    phone: null,
    linkedInUrl: null,
    portfolioUrl: null,
    location: { city: null, country: null },
    skills: [],
    detectedRoles: [],
    yearsExperience: null,
    education: [],
    certifications: [],
    professionalSummary: null,
    industry: null,
    educationLevel: null,
    confidenceScore: 0,
    needsAIParsing: true,
    parserVersion: PARSER_VERSION,
    parsedAt: new Date().toISOString(),
    _reason: reason,
  };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = Object.freeze({
  parseResumeText,
  mapParsedToOnboardingShape,
  detectSkills,
  detectRoles,
  extractSummary,
  computeConfidence,
});