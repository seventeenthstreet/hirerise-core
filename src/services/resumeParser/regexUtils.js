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
  // 'email.com' intentionally removed — it is a real registrable domain;
  // blocking it caused arunkumar@email.com and similar real addresses to be lost.
  'domain.com',
  'youremail.com',
  'mailaddress.com',
  'yourmail.com',
  'test.com',
  'placeholder.com',
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
  // Software product names that appear as bold text near the top of PDFs
  // and are incorrectly scored as names by the capitalisation heuristic.
  'zoho books', 'zoho crm', 'tally erp', 'tally prime',
  'quickbooks', 'microsoft excel', 'microsoft word', 'microsoft office',
  'ms excel', 'ms word', 'ms office', 'google sheets', 'google docs',
  'sap', 'oracle', 'salesforce', 'servicenow', 'hubspot',
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

  // ── Identify the "header block" — everything before the first blank line ──
  // PDFs often have no blank lines, so we fall back to the first 8 non-blank
  // lines (enough to cover name + contact + headline without reaching the
  // Skills or Software sections where product names like "Zoho Books" live).
  const allLines = text.split('\n').map(line => line.trim());
  const firstBlankIdx = allLines.findIndex(l => l === '');
  const headerEnd = firstBlankIdx > 0 ? Math.min(firstBlankIdx, 8) : 8;
  const headerLines = allLines.slice(0, headerEnd).filter(Boolean);

  // Full line list (filter blanks) used only for email-proximity search
  const lines = allLines.filter(Boolean).slice(0, 30);

  // ── Strategy 1: line immediately above the email address ─────────────────
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

  // ── Strategy 2: scan ONLY the header block (stops before software/skills) ─
  for (const line of headerLines) {
    if (/[@\d/|•–-]/.test(line)) continue;
    if (/http|www\.|linkedin|github/i.test(line)) continue;
    // Skip lines that look like section headers or skill lists
    if (/skills|experience|education|summary|objective|profile/i.test(line)) continue;

    if (scoreNameCandidate(line) >= 10) {
      return cleanName(line);
    }
  }

  // ── Strategy 3: CapWords regex restricted to first 300 chars ─────────────
  const head = text.slice(0, 300);
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

// ─── Education Extraction ─────────────────────────────────────────────────────
//
// WHY THE OLD LOGIC FAILED:
//   The old extractEducation() matched only 3 hard-coded abbreviations
//   (PhD, MBA, B.Tech). Any degree spelled out in full — "Bachelor of Commerce",
//   "Master of Science", "Diploma in Accounting" — returned nothing because no
//   pattern covered it. It also returned a flat string[] of labels, not the
//   structured objects the frontend and controller expect.
//
// NEW APPROACH:
//   1. Find the education section by its header (case-insensitive, many aliases).
//   2. Slice the text to just that section (stops at the next major header).
//   3. Within the section, identify individual entries. An entry begins when a
//      degree keyword appears on a line (or a year-range anchors it).
//   4. Parse each entry for: degree, institution, location, startYear, endYear.
//   5. Fall back to a full-document keyword scan for resumes without section
//      headers, so B.Tech / MBA / PhD etc. are never lost.
// ─────────────────────────────────────────────────────────────────────────────

// Section headers that open an education block
const EDUCATION_SECTION_RE =
  /^(?:education(?:al)?\s*(?:background|qualifications?|history)?|academic\s*(?:background|qualifications?|profile)|qualifications?|scholastic\s*details?)[\s:]*$/i;

// Headers that close the education block
const STOP_SECTION_RE =
  /^(?:experience|work\s*(?:experience|history)|employment|skills?|projects?|certifications?|awards?|publications?|references?|summary|profile|objective|languages?|interests?|hobbies|activities|achievements?)[\s:]*$/i;

// Degree opening words / abbreviations (used to anchor entry start)
const DEGREE_OPENER_RE =
  /\b(?:bachelor(?:'?s)?|master(?:'?s)?|doctor(?:ate)?|ph\.?d|m\.?b\.?a|b\.?tech|m\.?tech|b\.?e|m\.?e|b\.?sc|m\.?sc|b\.?com|m\.?com|b\.?a\.?|m\.?a\.?|llb|llm|mbbs|bds|b\.?ed|m\.?ed|diploma|post[\s-]?graduate|pg\s*diploma|associate\s*(?:of|degree)|certificate|higher\s*secondary|secondary|hsc|ssc|10th|12th)\b/i;

// Year-range patterns: "2014 – 2017", "2014-2017", "(2014 – 2017)", "2014 to 2017"
const YEAR_RANGE_RE =
  /\(?\b((?:19|20)\d{2})\s*(?:–|-{1,2}|to)\s*((?:19|20)\d{2}|present|current|now)\b\)?/i;

// Single year as fallback: "(2018)" or just "2018"
const SINGLE_YEAR_RE = /\(?((?:19|20)\d{2})\)?/;

// Separators between degree and institution: " – ", " - ", " at ", " from "
const DEGREE_INST_SEP_RE = /\s+(?:–|-{1,2}|at|from)\s+|\s*\|\s*/i;

// Separators between institution and location when on the same fragment:
// "Mahatma Gandhi University, Kerala" or "IIT Bombay | Mumbai"
const INST_LOC_SEP_RE = /\s*[,|]\s*/;

/**
 * Parse a single raw education entry (one job-like block of text) into a
 * structured object.  Returns null if we can't extract a meaningful degree.
 */
function parseEducationEntry(raw) {
  // Normalise internal whitespace but preserve newlines for multi-line entries
  const block = raw.replace(/[ \t]+/g, ' ').trim();
  if (!block) return null;

  // ── Extract and strip year range first (avoids it polluting other fields) ──
  let startYear = null;
  let endYear   = null;

  const yearRangeM = YEAR_RANGE_RE.exec(block);
  if (yearRangeM) {
    startYear = yearRangeM[1];
    endYear   = /^(present|current|now)$/i.test(yearRangeM[2])
      ? 'Present'
      : yearRangeM[2];
  } else {
    // Try two isolated years: "2018 – 2020" could be in parentheses already stripped
    const singleM = SINGLE_YEAR_RE.exec(block);
    if (singleM) startYear = singleM[1];
  }

  // Remove year spans from the block so they don't pollute degree/institution
  const stripped = block
    .replace(YEAR_RANGE_RE, '')
    .replace(/\(\s*\)/g, '')          // empty parens left behind
    .replace(/\bCGPA\s*[:–-]?\s*[\d.]+/gi, '')
    .replace(/\bGPA\s*[:–-]?\s*[\d.]+/gi, '')
    .replace(/\bgrade\s*[:–-]?\s*[\w.]+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // ── Split on the primary separator (–, -, at, from) ─────────────────────
  // We only split on the FIRST occurrence so "Bachelor of X – Uni, Loc" works
  const sepMatch = DEGREE_INST_SEP_RE.exec(stripped);

  let degreePart = '';
  let instPart   = '';

  if (sepMatch) {
    degreePart = stripped.slice(0, sepMatch.index).trim();
    instPart   = stripped.slice(sepMatch.index + sepMatch[0].length).trim();
  } else {
    // No separator — check for a newline split (multi-line block)
    const lines = stripped.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length >= 2) {
      degreePart = lines[0];
      instPart   = lines.slice(1).join(', ');
    } else {
      // Single-line, no separator: whole thing is the degree
      degreePart = stripped;
    }
  }

  // ── Degree: clean parenthetical specialisation but keep it ───────────────
  const degree = degreePart
    .replace(/^education\s*[:–-]?\s*/i, '')  // strip leading "Education:" prefix
    .replace(/^[\s\n:;–-]+/, '')             // strip any leading punctuation/whitespace artifacts
    .replace(/\n/g, ' ')                      // collapse newlines injected by flat-split
    .replace(/\s*[|·•]\s*.*$/, '')            // strip trailing pipe junk
    .replace(/\s*;\s*$/, '')                  // strip trailing semicolons
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (!degree || degree.length < 3) return null;

  // ── Institution + Location: split instPart on first comma or pipe ────────
  // But first strip any trailing year artifacts that weren't caught earlier,
  // plus trailing semicolons left by the semicolon-entry-split path.
  const instClean = instPart
    .replace(SINGLE_YEAR_RE, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s*;\s*$/, '')   // trailing semicolon from "Inst (years);" split
    .trim();
  let institution = '';
  let location    = '';

  if (instClean) {
    const locSepM = INST_LOC_SEP_RE.exec(instClean);
    if (locSepM) {
      institution = instClean.slice(0, locSepM.index).trim();
      const rawLoc = instClean.slice(locSepM.index + locSepM[0].length).trim();
      // Discard the "location" segment if it looks like the start of the next
      // degree entry (happens with pipe-separated entries not yet split).
      if (DEGREE_OPENER_RE.test(rawLoc)) {
        DEGREE_OPENER_RE.lastIndex = 0;
        location = '';
      } else {
        DEGREE_OPENER_RE.lastIndex = 0;
        // Keep only the first segment if there are further separators
        location = INST_LOC_SEP_RE.test(rawLoc)
          ? rawLoc.split(INST_LOC_SEP_RE)[0].trim()
          : rawLoc;
      }
    } else {
      institution = instClean;
    }
  }

  return {
    degree:      degree,
    institution: institution,
    location:    location,
    startYear:   startYear,
    endYear:     endYear,
  };
}

/**
 * Split a section block into individual education entry chunks.
 * Entries are delimited by blank lines OR by a new degree opener on a fresh line.
 */
function splitIntoEntries(sectionText) {
  // Strategy: accumulate lines into the current entry; flush when we see a
  // blank line followed by a degree opener, or a degree opener at line start
  // that isn't the very first line.
  const lines = sectionText.split('\n').map(l => l.trim());
  const chunks = [];
  let current = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!line) {
      // Blank line: if current has content, check if next non-blank starts a new entry
      if (current.length > 0) {
        let nextNonBlank = '';
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j]) { nextNonBlank = lines[j]; break; }
        }
        if (!nextNonBlank || DEGREE_OPENER_RE.test(nextNonBlank)) {
          chunks.push(current.join('\n'));
          current = [];
        }
        // else: blank line mid-entry (e.g. between inst and year) — keep going
      }
      continue;
    }

    // Non-blank line: if it STARTS WITH a degree keyword AND we already have
    // content, flush the current chunk.
    // Use a start-anchored test so "Certificate (HSC)" doesn't flush mid-entry.
    const startsWithDegree = /^(?:bachelor(?:'?s)?|master(?:'?s)?|doctorate?|ph\.?d|m\.?b\.?a|b\.?tech|m\.?tech|b\.?e\b|m\.?e\b|b\.?sc\b|m\.?sc\b|b\.?com\b|m\.?com\b|b\.?a\b|m\.?a\b|llb|llm|mbbs|bds|b\.?ed\b|m\.?ed\b|diploma|post[\s-]?graduate|pg\s*diploma|associate\s*(?:of|degree)|certificate\b|higher\s*secondary|hsc\b|ssc\b|10th|12th)\b/i.test(line);
    if (current.length > 0 && startsWithDegree) {
      const currentBlock = current.join(' ');
      if (YEAR_RANGE_RE.test(currentBlock) || SINGLE_YEAR_RE.test(currentBlock)) {
        chunks.push(current.join('\n'));
        current = [];
      }
    }

    current.push(line);
  }

  if (current.length > 0) chunks.push(current.join('\n'));

  // Also handle the single-line-per-entry case: "B.Com – Uni (2014-2017); Diploma – Inst (2017-2018)"
  const flatChunks = [];
  for (const chunk of chunks) {
    if (!chunk.includes('\n') && /;\s*/.test(chunk)) {
      flatChunks.push(...chunk.split(/;\s*/));
    } else {
      flatChunks.push(chunk);
    }
  }

  return flatChunks.filter(c => c.trim().length > 0);
}

function extractEducation(input) {
  const text = normalizeText(input);
  if (!text.trim()) return [];

  const lines = text.split('\n').map(l => l.trim());

  // ── Step 1: find the education section ───────────────────────────────────
  let sectionStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (EDUCATION_SECTION_RE.test(lines[i])) {
      sectionStart = i + 1;
      break;
    }
  }

  // ── Step 2: if no section header, fall back to whole-document scan ───────
  // (handles resumes that list education inline without a header)
  let rawScanText = sectionStart === -1
    ? text
    : (() => {
        // Slice from section header to the next stop-section header
        let end = lines.length;
        for (let i = sectionStart; i < lines.length; i++) {
          if (STOP_SECTION_RE.test(lines[i]) && i > sectionStart + 1) {
            end = i;
            break;
          }
        }
        return lines.slice(sectionStart, end).join('\n');
      })();

  // ── Step 2b: if the whole section is one long line (PDF flat text), ──────
  // inject newlines before each degree opener so the entry splitter works.
  // Heuristic: if there are no newlines but multiple degree openers exist,
  // the text was collapsed during PDF extraction.
  const lineCount  = (rawScanText.match(/\n/g) || []).length;
  const degreeHits = (rawScanText.match(new RegExp(DEGREE_OPENER_RE.source, 'gi')) || []).length;

  // Static regex matching the same tokens as DEGREE_OPENER_RE — used for the
  // split (avoids lookbehind + dynamic source issues).
  // Uses word-boundary assertions via surrounding non-word chars as guards.
  const FLAT_SPLIT_RE =
    /(?<![a-zA-Z])(?=(?:bachelor(?:'?s)?|master(?:'?s)?|doctorate?|ph\.?d|m\.?b\.?a|b\.?tech|m\.?tech|b\.?e\b|m\.?e\b|b\.?sc\b|m\.?sc\b|b\.?com\b|m\.?com\b|b\.?a\b|m\.?a\b|llb|llm|mbbs|bds|b\.?ed\b|m\.?ed\b|diploma|post[\s-]?graduate|pg\s*diploma|associate\s*(?:of|degree)|certificate\b|higher\s*secondary|hsc\b|ssc\b|10th|12th)\b)/gi;

  const scanText = (lineCount === 0 && degreeHits > 1)
    ? rawScanText
        // strip the leading "Education" / "Education:" header that has no newline after it
        .replace(/^education\s*[:\s]*/i, '')
        // inject newlines before each degree opener
        .split(FLAT_SPLIT_RE).join('\n')
    : rawScanText;

  // ── Step 3: split into individual entries and parse each ─────────────────
  const chunks = splitIntoEntries(scanText);
  const results = [];

  for (const chunk of chunks) {
    // Only process chunks that contain a recognisable degree keyword
    if (!DEGREE_OPENER_RE.test(chunk)) continue;

    const entry = parseEducationEntry(chunk);
    if (entry && entry.degree.length >= 3) {
      results.push(entry);
    }
  }

  // ── Step 4: dedup by degree name (case-insensitive) ──────────────────────
  const seen = new Set();
  return results.filter(e => {
    const key = e.degree.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  // Medical / clinical CV headers
  'clinical experience',
  'clinical work',
  'hospital experience',
  'medical experience',
  // Internship section headers — NOTE: keep these as concise labels only.
  // Multi-word job titles like "Compulsory Rotating Internship" are NOT section headers;
  // they appear as content lines under the "INTERNSHIP" header and must NOT be added here
  // or they will incorrectly open a new spurious section range.
  'internship',
  'internships',
  'internship experience',
  'industrial training',
  'practical training',
  'clinical training',
  'field training',
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

// PDF inline format: "Senior Accountant – ABC Trading Pvt Ltd (June 2021 – Present)"
// Captures: [title] [–/-] [company] [(date – date)] or [, date – date]
// The date range part is optional here — we strip it separately.
// Uses a lazy match so the FIRST em-dash separates title from company.
const TITLE_COMPANY_DASH_RE = /^(.+?)\s*[–—]\s*(.+?)(?:\s*[\(\[,].*)?$/;

/**
 * Returns true if the lowercased, colon-stripped line is an experience-type header.
 * Supports both exact set membership AND partial keyword matching so that headers
 * like "Clinical Experience", "XYZ Internship", or "Volunteer Experience" are caught
 * even if they are not in the exact EXPERIENCE_SECTION_HEADERS set.
 *
 * Guard: partial-match only fires for short lines (≤ 40 chars) that look like section
 * headers, NOT for content lines like "Compulsory Rotating Internship" which are job
 * titles and should NOT be treated as section openers.
 */
function _isExperienceHeader(lower) {
  if (EXPERIENCE_SECTION_HEADERS.has(lower)) return true;

  if (lower.length > 40) return false;

  const wordCount = lower.trim().split(/\s+/).length;

  // "xyz experience" patterns — e.g. "clinical experience", "volunteer experience"
  if (/\bexperience\b/.test(lower) && wordCount <= 3) return true;

  // "xyz internship/s" — only 1-2 word lines to avoid job titles being misread
  if (/\binternships?\b/.test(lower) && wordCount <= 2) return true;

  return false;
}

/**
 * Returns true if the lowercased line marks a stop boundary (non-experience section).
 * Uses includes-based partial match so "key skills", "professional summary" etc. all fire.
 */
function _isStopHeader(lower) {
  if (EDUCATION_SECTION_HEADERS_EXP.has(lower)) return true;
  // Partial matches for common multi-word stop headers not in the exact set
  if (lower.includes('skill') && lower.length <= 30) return true;
  if (lower.includes('summary') && lower.length <= 30) return true;
  if (lower.includes('objective') && lower.length <= 30) return true;
  if (lower.includes('education') && lower.length <= 30) return true;
  if (lower.includes('qualification') && lower.length <= 30) return true;
  return false;
}

function extractExperience(input) {
  const text = normalizeText(input);
  const lines = text.split('\n').map(l => l.trim());

  // ── Collect ALL experience-like section ranges ────────────────────────────
  // A CV may have separate "Experience" and "Internship" sections; both count
  // as experience entries (internship is NOT education).  We scan the whole
  // document for every matching section header and gather lines from each.
  const sectionRanges = []; // [{ start, end }]

  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase().replace(/:$/, '').trim();
    if (_isExperienceHeader(lower)) {
      const start = i + 1;
      // Find end = next stop-section or another experience-section header
      let end = lines.length;
      for (let j = start; j < lines.length; j++) {
        const jLower = lines[j].toLowerCase().replace(/:$/, '').trim();
        if ((_isStopHeader(jLower) || _isExperienceHeader(jLower)) && j > start + 1) {
          end = j;
          break;
        }
      }
      sectionRanges.push({ start, end });
    }
  }

  if (sectionRanges.length === 0) return [];

  // ── Process each section range and accumulate entries ────────────────────
  const allEntries = [];

  for (const { start, end } of sectionRanges) {
    const sectionLines = lines.slice(start, end).filter(Boolean);
    const entries = _parseExperienceSection(sectionLines);
    allEntries.push(...entries);
    // Hard cap: never return more than 10 entries total
    if (allEntries.length >= 10) break;
  }

  return allEntries;
}

/**
 * Internal: parse a single flat list of section lines into structured entries.
 * Handles two layouts:
 *
 * LAYOUT A — multi-line (DOCX / well-structured PDF):
 *   Line N-2: Job Title
 *   Line N-1: Company Name
 *   Line N:   2020 – 2022
 *
 * LAYOUT B — inline (compact PDF):
 *   Line N: Senior Accountant – ABC Trading Pvt Ltd (June 2021 – Present)
 *   Line N+1: Description text...
 *
 * LAYOUT C — no date (DOCX internship / training blocks):
 *   Line 0: Compulsory Rotating Internship
 *   Line 1: Government Medical College Hospital
 *   Line 2+: Description bullets
 */
function _parseExperienceSection(sectionLines) {
  // ── Pass 1: find anchor indices where a date range appears ──────────────
  const anchors = [];
  for (let i = 0; i < sectionLines.length; i++) {
    const line = sectionLines[i];
    DATE_RANGE_RE.lastIndex = 0;
    const m = DATE_RANGE_RE.exec(line);
    if (m) {
      DATE_RANGE_RE.lastIndex = 0;
      const parts = m[0].split(/[–\-—]|(?:\bto\b)/i).map(s => s.trim());
      anchors.push({
        lineIdx:   i,
        startDate: parts[0] ?? '',
        endDate:   (parts[1] ?? '').replace(/^(present|current|now)$/i, 'Present'),
        // Flag: is the date embedded inline with title/company on the same line?
        isInline:  _hasNonDateContent(line, m[0]),
      });
    }
  }

  // ── LAYOUT C: no date range found — build one entry from the section lines ─
  // This handles internship / training blocks that list a role and institution
  // but no year range (common in Indian medical CVs and fresh-graduate CVs).
  if (anchors.length === 0) {
    if (sectionLines.length === 0) return [];

    const nonEmpty = sectionLines.filter(Boolean);
    if (nonEmpty.length === 0) return [];

    let title   = nonEmpty[0];
    let company = nonEmpty[1] ?? '';

    // If the first line contains a separator, split it into title + company
    const dashM = TITLE_COMPANY_DASH_RE.exec(title);
    const atM   = TITLE_COMPANY_AT_RE.exec(title);
    const pipeM = TITLE_COMPANY_PIPE_RE.exec(title);

    if (dashM && dashM[1] && dashM[2]) {
      title   = dashM[1].trim();
      company = dashM[2].trim();
    } else if (atM) {
      title   = atM[1].trim();
      company = atM[2].trim();
    } else if (pipeM) {
      title   = pipeM[1].trim();
      company = pipeM[2].trim();
    }

    if (!title || title.length < 2) return [];

    const descLines = nonEmpty.slice(company ? 2 : 1, 7)
      .map(dl => dl.replace(/^[-•·]\s*/, ''));

    return [{
      id:          `exp-0-${Date.now()}`,
      title:       title.replace(/^[-•·]\s*/, ''),
      company:     company.replace(/^[-•·]\s*/, ''),
      start_date:  null,
      end_date:    null,
      description: descLines.join(' ').slice(0, 400),
    }];
  }

  const entries = [];

  for (let a = 0; a < anchors.length && entries.length < 6; a++) {
    const { lineIdx, startDate, endDate, isInline } = anchors[a];
    const nextAnchorLine = anchors[a + 1]?.lineIdx ?? sectionLines.length;

    let title   = '';
    let company = '';

    // ── Bug fix (WP-PRO-09N): a date line that also carries a trailing
    // location fragment (e.g. "New York, NY | 2021 – Present") was being
    // treated as LAYOUT B ("Title – Company" inline with the date) purely
    // because SOME non-date text remained on the line. That leftover text
    // is frequently just a location, not a title/company pair — while the
    // real title + company were sitting on the two lines immediately
    // before the anchor (LAYOUT A). Blindly trusting `isInline` discarded
    // those real title/company lines and used the location string as the
    // title instead, with company left blank.
    //
    // Fix: only trust the inline reading when the leftover content on the
    // date line actually contains a recognised title/company separator
    // (dash, "at", or pipe). If it doesn't, and there are usable preceding
    // lines, fall back to the LAYOUT A (preceding-lines) reading, which is
    // far more likely to hold the real title/company.
    const blockStartForCheck = a === 0 ? 0 : anchors[a - 1].lineIdx + 1;
    const preLinesForCheck   = sectionLines.slice(blockStartForCheck, lineIdx).filter(Boolean);

    let useInlineLayout = isInline;
    if (isInline) {
      DATE_RANGE_RE.lastIndex = 0;
      const strippedForCheck = sectionLines[lineIdx]
        .replace(DATE_RANGE_RE, '')
        .replace(/\(\s*\)/g, '')
        .replace(/\[\s*\]/g, '')
        .replace(/,\s*$/, '')
        .trim();
      DATE_RANGE_RE.lastIndex = 0;

      const hasSeparator =
        TITLE_COMPANY_DASH_RE.test(strippedForCheck) ||
        TITLE_COMPANY_AT_RE.test(strippedForCheck) ||
        TITLE_COMPANY_PIPE_RE.test(strippedForCheck);

      if (!hasSeparator && preLinesForCheck.length >= 1) {
        // No "Title – Company" pattern on the date line itself, and we have
        // real preceding lines to fall back on — prefer LAYOUT A.
        useInlineLayout = false;
      }
    }

    if (useInlineLayout) {
      // ── LAYOUT B: title and company are on the SAME line as the date ──────
      // Strip the date range (and surrounding parens/brackets) from the line
      // to isolate "Title – Company".
      const dateLine = sectionLines[lineIdx];
      DATE_RANGE_RE.lastIndex = 0;
      const withoutDate = dateLine
        .replace(DATE_RANGE_RE, '')
        .replace(/\(\s*\)/g, '')   // remove empty parens left after date strip
        .replace(/\[\s*\]/g, '')   // remove empty brackets
        .replace(/,\s*$/, '')      // trailing comma
        .trim();
      DATE_RANGE_RE.lastIndex = 0;

      // Now try "Title – Company" split on the inline separator
      const dashM = TITLE_COMPANY_DASH_RE.exec(withoutDate);
      const atM   = TITLE_COMPANY_AT_RE.exec(withoutDate);
      const pipeM = TITLE_COMPANY_PIPE_RE.exec(withoutDate);

      if (dashM && dashM[1] && dashM[2]) {
        title   = dashM[1].trim();
        company = dashM[2].trim().replace(/\(\s*\)$/, '').trim();
      } else if (atM) {
        title   = atM[1].trim();
        company = atM[2].trim();
      } else if (pipeM) {
        title   = pipeM[1].trim();
        company = pipeM[2].trim();
      } else {
        // No separator found — use the whole cleaned line as the title
        title = withoutDate;
      }
    } else {
      // ── LAYOUT A: date is on its own line; title/company are on prior lines ─
      const blockStart = a === 0 ? 0 : anchors[a - 1].lineIdx + 1;
      const preLines   = sectionLines.slice(blockStart, lineIdx).filter(Boolean);

      if (preLines.length >= 2) {
        title   = preLines[preLines.length - 2];
        company = preLines[preLines.length - 1];
      } else if (preLines.length === 1) {
        const single = preLines[0];
        const atM    = TITLE_COMPANY_AT_RE.exec(single);
        const pipeM  = TITLE_COMPANY_PIPE_RE.exec(single);
        const dashM  = TITLE_COMPANY_DASH_RE.exec(single);
        if (atM)        { title = atM[1].trim();   company = atM[2].trim(); }
        else if (pipeM) { title = pipeM[1].trim(); company = pipeM[2].trim(); }
        else if (dashM) { title = dashM[1].trim(); company = dashM[2].trim(); }
        else            { title = single; }
      } else {
        // Date is the very first line in the section — extract anything beside it
        const dateLine = sectionLines[lineIdx];
        DATE_RANGE_RE.lastIndex = 0;
        const stripped = dateLine.replace(DATE_RANGE_RE, '').replace(/[–\-—|·•,]+/g, '').trim();
        DATE_RANGE_RE.lastIndex = 0;
        if (stripped.length > 1) title = stripped;
      }
    }

    if (!title || title.length < 2 || title.length > 120) continue;
    if (/^\d{4}/.test(title)) continue;
    if (/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(title) &&
        /\d{4}/.test(title)) continue;

    const nextPreLines = new Set(
      anchors[a + 1]
        ? sectionLines.slice(lineIdx + 1, anchors[a + 1].lineIdx).filter(Boolean).slice(-2)
        : []
    );

    const descLines = sectionLines
      .slice(lineIdx + 1, nextAnchorLine)
      .filter(dl => {
        if (!dl) return false;
        if (nextPreLines.has(dl)) return false;
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

/**
 * Returns true if a line contains meaningful non-date content alongside the
 * matched date string — i.e. it is an "inline" entry where title/company and
 * date are all on the same line.
 */
function _hasNonDateContent(line, dateMatch) {
  const withoutDate = line
    .replace(dateMatch, '')
    .replace(/[\(\[\]\)–\-—,]+/g, ' ')
    .trim();
  // If there are >= 3 non-whitespace chars left, there's a title/company here
  return withoutDate.replace(/\s+/g, '').length >= 3;
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