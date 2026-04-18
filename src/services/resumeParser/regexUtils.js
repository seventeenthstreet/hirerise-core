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

// ───────────────────────────────────────────────────────────────────────────────
// Experience Extraction
// Produces structured { id, title, company, start_date, end_date, description }[]
// by scanning for common work-history section headers and date patterns.
// ───────────────────────────────────────────────────────────────────────────────

const EXPERIENCE_SECTION_HEADERS = new Set([
  'experience',
  'work experience',
  'professional experience',
  'employment history',
  'work history',
  'career history',
  'positions held',
  'employment',
]);

const EDUCATION_SECTION_HEADERS_EXP = new Set([
  'education',
  'academic background',
  'qualifications',
  'certifications',
  'skills',
  'projects',
  'references',
  'awards',
  'publications',
  'summary',
  'profile',
  'objective',
]);

// Matches: Jan 2020 – Mar 2022 / 2018 - Present / 01/2019 – 12/2021
const DATE_RANGE_RE =
  /(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+)?\d{4}\s*[–\-—to]+\s*(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+)?(?:\d{4}|present|current|now)/gi;

// Matches a line that looks like "Job Title  |  Company Name" or "Job Title at Company"
const TITLE_COMPANY_AT_RE = /^(.+?)\s+at\s+(.+)$/i;
const TITLE_COMPANY_PIPE_RE = /^(.+?)\s*[\|·•]\s*(.+)$/;

function extractExperience(input) {
  const text = normalizeText(input);
  const lines = text.split('\n').map(l => l.trim());

  // Find the start of the experience section
  let sectionStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase().replace(/:$/, '');
    if (EXPERIENCE_SECTION_HEADERS.has(lower)) {
      sectionStart = i + 1;
      break;
    }
  }

  if (sectionStart === -1) return [];

  // Find the end of the experience section (next major section header)
  let sectionEnd = lines.length;
  for (let i = sectionStart; i < lines.length; i++) {
    const lower = lines[i].toLowerCase().replace(/:$/, '');
    if (EDUCATION_SECTION_HEADERS_EXP.has(lower) && i > sectionStart + 2) {
      sectionEnd = i;
      break;
    }
  }

  const sectionLines = lines.slice(sectionStart, sectionEnd).filter(Boolean);

  // ── Pass 1: find anchor indices where a date range appears ──────────────
  // Each anchor marks the rough start of a new job entry.
  const anchors = []; // { lineIdx, startDate, endDate }
  for (let i = 0; i < sectionLines.length; i++) {
    const line = sectionLines[i];
    // Reset regex before each test (global flag)
    DATE_RANGE_RE.lastIndex = 0;
    const m = DATE_RANGE_RE.exec(line);
    if (m) {
      DATE_RANGE_RE.lastIndex = 0;
      const parts = m[0].split(/[–\-—]|(?:\bto\b)/i).map(s => s.trim());
      anchors.push({
        lineIdx:   i,
        startDate: parts[0] ?? '',
        endDate:   (parts[1] ?? '').replace(/^(present|current|now)$/i, 'Present'),
      });
    }
  }

  if (anchors.length === 0) return [];

  const entries = [];

  for (let a = 0; a < anchors.length && entries.length < 6; a++) {
    const { lineIdx, startDate, endDate } = anchors[a];
    const nextAnchorLine = anchors[a + 1]?.lineIdx ?? sectionLines.length;

    // The date line itself — look 1-2 lines *before* for Title / Company
    let title   = '';
    let company = '';

    // Lines before the date line (within this block)
    const blockStart = a === 0 ? 0 : anchors[a - 1].lineIdx + 1;
    const preLines   = sectionLines.slice(blockStart, lineIdx).filter(Boolean);

    if (preLines.length >= 2) {
      // Last two non-empty lines before the date: typically Title then Company
      const last  = preLines[preLines.length - 1];
      const prev  = preLines[preLines.length - 2];
      // Heuristic: shorter of the two is more likely a company name
      title   = prev;
      company = last;
    } else if (preLines.length === 1) {
      // Try to split "Title at Company" or "Title | Company"
      const single = preLines[0];
      const atM    = TITLE_COMPANY_AT_RE.exec(single);
      const pipeM  = TITLE_COMPANY_PIPE_RE.exec(single);
      if (atM)        { title = atM[1].trim();   company = atM[2].trim(); }
      else if (pipeM) { title = pipeM[1].trim(); company = pipeM[2].trim(); }
      else            { title = single; }
    } else {
      // No pre-lines — title might be on the same line as the date, stripped out
      const dateLine = sectionLines[lineIdx];
      DATE_RANGE_RE.lastIndex = 0;
      const stripped = dateLine.replace(DATE_RANGE_RE, '').replace(/[–\-—|·•,]+/g, '').trim();
      DATE_RANGE_RE.lastIndex = 0;
      if (stripped.length > 1) title = stripped;
    }

    // Skip entries where we couldn't resolve a sensible title
    if (!title || title.length < 2 || title.length > 120) continue;
    // Skip if the title looks like it IS a date (mis-parsed)
    if (/^\d{4}/.test(title) || /(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(title)) continue;

    // Description: bullet lines between the date line and the next anchor.
    // Stop early if we hit what looks like the next entry's title or company
    // (the pre-date lines of the next anchor block).
    const nextBlockPreStart = anchors[a + 1]
      ? (a + 1 === 0 ? 0 : anchors[a].lineIdx + 1)
      : sectionLines.length;
    const nextPreLines = new Set(
      anchors[a + 1]
        ? sectionLines.slice(lineIdx + 1, anchors[a + 1].lineIdx).filter(Boolean).slice(-2)
        : []
    );

    const descLines = sectionLines
      .slice(lineIdx + 1, nextAnchorLine)
      .filter(dl => {
        if (!dl) return false;
        // Skip lines that are the next entry's title or company header
        if (nextPreLines.has(dl)) return false;
        // Skip lines that look like a date range
        DATE_RANGE_RE.lastIndex = 0;
        const hasDate = DATE_RANGE_RE.test(dl);
        DATE_RANGE_RE.lastIndex = 0;
        return !hasDate;
      })
      .slice(0, 6)
      .map(dl => dl.replace(/^[-•·]\s*/, ''));

    entries.push({
      id:          `exp-${entries.length}-${Date.now()}`,
      title:       title.replace(/^[-•·]\s*/, ''),
      company:     company.replace(/^[-•·]\s*/, ''),
      start_date:  startDate,
      end_date:    endDate,
      description: descLines.join(' ').slice(0, 400),
    });
  }

  return entries;
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
  extractExperience,
  extractIndustry,
  extractEducationLevel,
  CITIES,
  COUNTRIES,
});