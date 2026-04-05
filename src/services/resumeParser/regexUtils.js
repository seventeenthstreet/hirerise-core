'use strict';

/**
 * services/resumeParser/regexUtils.js
 *
 * Production-grade deterministic resume field extraction utilities.
 * Fully infrastructure-agnostic and optimized for Supabase ingestion pipelines.
 *
 * Key guarantees:
 * - no Firebase dependencies
 * - no mutable regex state bugs
 * - low repeated CPU scans
 * - null-safe extraction
 * - stable deterministic output
 */

// ───────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ───────────────────────────────────────────────────────────────────────────────

function normalizeText(text) {
  return typeof text === 'string' ? text : '';
}

function normalizeLower(text) {
  return normalizeText(text).toLowerCase();
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ───────────────────────────────────────────────────────────────────────────────
// Email
// ───────────────────────────────────────────────────────────────────────────────

const EMAIL_REGEX = /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,10}\b/g;
const SKIP_EMAIL_DOMAINS = new Set([
  'example.com',
  'email.com',
  'domain.com',
  'youremail.com',
  'test.com',
]);

function extractEmail(input) {
  const text = normalizeText(input);
  const matches = text.match(EMAIL_REGEX) || [];

  for (const email of matches) {
    const domain = email.split('@')[1]?.toLowerCase() || '';
    if (!SKIP_EMAIL_DOMAINS.has(domain)) {
      return email.toLowerCase();
    }
  }

  return null;
}

// ───────────────────────────────────────────────────────────────────────────────
// Phone
// ───────────────────────────────────────────────────────────────────────────────

const PHONE_REGEXES = [
  /\+\d{1,3}[\s\-.]?\(?\d{1,4}\)?[\s\-.]?\d{3,5}[\s\-.]?\d{4,6}/g,
  /\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4}/g,
  /(?<!\d)(?:0)?[6789]\d{9}(?!\d)/g,
  /(?<!\d)\d{10,15}(?!\d)/g,
];

function extractPhone(input) {
  const text = normalizeText(input).replace(/https?:\/\/[^\s]+/gi, '');

  for (const regex of PHONE_REGEXES) {
    const matches = text.match(regex) || [];
    for (const match of matches) {
      const digits = match.replace(/\D/g, '');
      if (digits.length >= 7 && digits.length <= 15) {
        return match.trim();
      }
    }
  }

  return null;
}

// ───────────────────────────────────────────────────────────────────────────────
// Social / Portfolio
// ───────────────────────────────────────────────────────────────────────────────

const LINKEDIN_REGEX =
  /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[\w\-%.]+\/?/i;

const GITHUB_REGEX =
  /(?:https?:\/\/)?(?:www\.)?github\.com\/[\w\-]+\/?/i;

const PORTFOLIO_REGEX =
  /https?:\/\/(?!(?:www\.)?(linkedin|twitter|facebook|instagram|youtube)\.com)[\w\-]+(?:\.[\w\-]+)+(?:\/[\w\-./?%&=]*)?/i;

function normalizeUrl(url) {
  if (!url) return null;
  return url.startsWith('http') ? url.trim() : `https://${url.trim()}`;
}

function extractLinkedIn(input) {
  const text = normalizeText(input);
  const match = text.match(LINKEDIN_REGEX)?.[0];
  return normalizeUrl(match);
}

function extractPortfolio(input) {
  const text = normalizeText(input);

  const github = text.match(GITHUB_REGEX)?.[0];
  if (github) return normalizeUrl(github);

  const portfolio = text.match(PORTFOLIO_REGEX)?.[0];
  return portfolio || null;
}

// ───────────────────────────────────────────────────────────────────────────────
// Name
// ───────────────────────────────────────────────────────────────────────────────

const NAME_BLACKLIST = new Set([
  'resume', 'curriculum vitae', 'cv', 'profile', 'contact',
  'summary', 'experience', 'education', 'skills', 'projects',
  'certifications', 'awards', 'references',
]);

const HONORIFICS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'er', 'ca', 'cs',
]);

function cleanName(raw) {
  return raw
    .trim()
    .split(/\s+/)
    .filter(word => !HONORIFICS.has(word.toLowerCase().replace('.', '')))
    .join(' ');
}

function scoreNameCandidate(candidate) {
  const trimmed = candidate.trim();
  const lower = trimmed.toLowerCase();

  if (!trimmed || NAME_BLACKLIST.has(lower)) return 0;

  const words = trimmed.split(/\s+/);
  if (words.length < 1 || words.length > 5) return 0;

  const capitalized = words.every(w => /^[A-Z]/.test(w));
  if (!capitalized) return 0;

  return words.length >= 2 ? 15 : 10;
}

function extractName(input) {
  const text = normalizeText(input);
  const lines = text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 30);

  const email = extractEmail(text);
  const emailLineIndex = email
    ? lines.findIndex(line => line.toLowerCase().includes(email))
    : -1;

  if (emailLineIndex > 0) {
    const candidate = lines[emailLineIndex - 1];
    if (scoreNameCandidate(candidate) >= 10) {
      return cleanName(candidate);
    }
  }

  for (let i = 0; i < Math.min(10, lines.length); i++) {
    const line = lines[i];

    if (/[@\d/|•–-]/.test(line)) continue;
    if (/http|www\.|linkedin|github/i.test(line)) continue;

    if (scoreNameCandidate(line) >= 10) {
      return cleanName(line);
    }
  }

  const head = text.slice(0, 500);
  const capWords = /\b([A-Z][a-z]{1,20})(?:\s+[A-Z][a-z]{1,20}){1,2}\b/g;
  const matches = head.match(capWords) || [];

  for (const match of matches) {
    if (scoreNameCandidate(match) >= 10) {
      return cleanName(match);
    }
  }

  return null;
}

// ───────────────────────────────────────────────────────────────────────────────
// Location
// ───────────────────────────────────────────────────────────────────────────────

const CITIES = [
  'Thiruvananthapuram',
  'Trivandrum',
  'Dubai',
  'Mumbai',
  'Delhi',
  'Bangalore',
  'London',
  'New York',
  'Singapore',
];

const COUNTRIES = [
  'India',
  'United Arab Emirates',
  'UAE',
  'United States',
  'USA',
  'United Kingdom',
  'UK',
  'Singapore',
];

const SORTED_CITIES = [...CITIES].sort((a, b) => b.length - a.length);

function extractLocation(input) {
  const text = normalizeText(input);
  const result = { city: null, country: null };

  for (const country of COUNTRIES) {
    const regex = new RegExp(`\\b${escapeRegex(country)}\\b`, 'i');
    if (regex.test(text)) {
      result.country =
        country === 'UAE' ? 'United Arab Emirates' : country;
      break;
    }
  }

  for (const city of SORTED_CITIES) {
    const regex = new RegExp(`\\b${escapeRegex(city)}\\b`, 'i');
    if (regex.test(text)) {
      result.city = city;
      break;
    }
  }

  return result;
}

// ───────────────────────────────────────────────────────────────────────────────
// Experience / Education / Industry
// ───────────────────────────────────────────────────────────────────────────────

const EXPERIENCE_PATTERNS = [
  /(\d+(?:\.\d+)?)\+?\s*(?:years?|yrs?)\s+(?:of\s+)?experience/gi,
  /experience\s+of\s+(\d+(?:\.\d+)?)\+?\s*(?:years?|yrs?)/gi,
];

function extractYearsOfExperience(input) {
  const text = normalizeText(input);
  const values = [];

  for (const pattern of EXPERIENCE_PATTERNS) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const value = Number.parseFloat(match[1]);
      if (Number.isFinite(value) && value >= 0 && value <= 60) {
        values.push(value);
      }
    }
    pattern.lastIndex = 0;
  }

  return values.length ? Math.max(...values) : null;
}

const DEGREE_PATTERNS = [
  { pattern: /\bph\.?d\.?\b/i, label: 'PhD' },
  { pattern: /\bm\.?b\.?a\.?\b/i, label: 'MBA' },
  { pattern: /\bb\.?tech\.?\b/i, label: 'B.Tech' },
];

function extractEducation(input) {
  const text = normalizeText(input);
  const found = new Set();

  for (const { pattern, label } of DEGREE_PATTERNS) {
    if (pattern.test(text)) found.add(label);
  }

  return [...found];
}

const INDUSTRY_KEYWORDS = [
  {
    industry: 'Technology & Software',
    keywords: ['software', 'developer', 'engineer', 'react', 'node'],
  },
  {
    industry: 'Finance & Banking',
    keywords: ['finance', 'accounting', 'audit', 'tax'],
  },
];

function extractIndustry(input) {
  const lower = normalizeLower(input);

  let best = null;
  let bestScore = 0;

  for (const { industry, keywords } of INDUSTRY_KEYWORDS) {
    let score = 0;
    for (const keyword of keywords) {
      if (lower.includes(keyword)) score++;
    }

    if (score > bestScore) {
      bestScore = score;
      best = industry;
    }
  }

  return best;
}

const EDUCATION_LEVEL_MAP = [
  { level: 'PhD', patterns: [/\bph\.?d\.?\b/i] },
  { level: 'MBA', patterns: [/\bm\.?b\.?a\.?\b/i] },
  { level: 'Bachelor\'s Degree', patterns: [/\bb\.?tech\.?\b/i] },
];

function extractEducationLevel(input) {
  const text = normalizeText(input);

  for (const { level, patterns } of EDUCATION_LEVEL_MAP) {
    if (patterns.some(pattern => pattern.test(text))) {
      return level;
    }
  }

  return null;
}

module.exports = Object.freeze({
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
  CITIES,
  COUNTRIES,
});