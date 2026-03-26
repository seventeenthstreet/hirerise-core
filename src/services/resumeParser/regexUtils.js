'use strict';

/**
 * regexUtils.js
 *
 * Battle-tested regex patterns for extracting personal contact fields
 * from raw resume text. Patterns are ordered by specificity (most specific first).
 *
 * All functions return the first confident match or null.
 */

// ── Email ──────────────────────────────────────────────────────────────────────

const EMAIL_REGEX = /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,10}\b/gi;

/**
 * Extract the first valid email from resume text.
 * Skips obviously fake emails (e.g. "example@example.com", "yourname@email.com")
 */
function extractEmail(text) {
  const SKIP_DOMAINS = new Set(['example.com', 'email.com', 'domain.com', 'youremail.com', 'test.com']);
  const matches = text.match(EMAIL_REGEX) || [];
  for (const match of matches) {
    const domain = match.split('@')[1]?.toLowerCase() ?? '';
    if (!SKIP_DOMAINS.has(domain)) return match.toLowerCase();
  }
  return null;
}

// ── Phone ──────────────────────────────────────────────────────────────────────

// Covers: +91 9876543210, 09876543210, (971) 50-123-4567, +971501234567, 123-456-7890
const PHONE_REGEXES = [
  // International with country code: +91 98765 43210
  /\+\d{1,3}[\s\-.]?\(?\d{1,4}\)?[\s\-.]?\d{3,5}[\s\-.]?\d{4,6}/g,
  // US/Canada format: (123) 456-7890 or 123-456-7890
  /\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4}/g,
  // Indian 10-digit: 9876543210 or 09876543210
  /(?<!\d)(?:0)?[6789]\d{9}(?!\d)/g,
  // Generic 10-15 digit number
  /(?<!\d)\d{10,15}(?!\d)/g,
];

/**
 * Extract the first plausible phone number from resume text.
 * Returns the original formatting (no normalisation).
 */
function extractPhone(text) {
  // Strip URLs first so we don't match port numbers
  const cleaned = text.replace(/https?:\/\/[^\s]+/gi, '');
  for (const regex of PHONE_REGEXES) {
    const matches = cleaned.match(regex) || [];
    for (const match of matches) {
      const digits = match.replace(/\D/g, '');
      if (digits.length >= 7 && digits.length <= 15) return match.trim();
    }
  }
  return null;
}

// ── LinkedIn ───────────────────────────────────────────────────────────────────

const LINKEDIN_REGEX = /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[\w\-%.]+\/?/gi;
const LINKEDIN_SHORT = /linkedin\.com\/in\/[\w\-%.]+/gi;

function extractLinkedIn(text) {
  const full = text.match(LINKEDIN_REGEX)?.[0] ?? text.match(LINKEDIN_SHORT)?.[0] ?? null;
  if (!full) return null;
  // Normalise: ensure https:// prefix
  return full.startsWith('http') ? full.trim() : `https://${full.trim()}`;
}

// ── Portfolio / GitHub / Website ───────────────────────────────────────────────

const GITHUB_REGEX = /(?:https?:\/\/)?(?:www\.)?github\.com\/[\w\-]+\/?/gi;
const PORTFOLIO_REGEX = /https?:\/\/(?!(?:www\.)?(linkedin|twitter|facebook|instagram|youtube)\.com)[\w\-]+(?:\.[\w\-]+)+(?:\/[\w\-./?%&=]*)?/gi;

function extractPortfolio(text) {
  // Prefer GitHub
  const ghMatch = text.match(GITHUB_REGEX)?.[0];
  if (ghMatch) {
    return ghMatch.startsWith('http') ? ghMatch.trim() : `https://${ghMatch.trim()}`;
  }
  // Then any other URL that isn't LinkedIn/social media
  const webMatch = text.match(PORTFOLIO_REGEX)?.[0];
  return webMatch ?? null;
}

// ── Name ───────────────────────────────────────────────────────────────────────

const NAME_BLACKLIST = new Set([
  'resume', 'curriculum vitae', 'cv', 'profile', 'contact', 'address', 'objective',
  'summary', 'experience', 'education', 'skills', 'work', 'employment', 'references',
  'declaration', 'personal', 'details', 'information', 'projects', 'publications',
  'achievements', 'hobbies', 'interests', 'volunteer', 'certifications', 'awards',
  'languages', 'activities', 'internship', 'professional',
]);

const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'er', 'ca', 'cs', 'sir', 'shri', 'smt']);
const SINGLE_LETTERS = /^[a-z]\.?$/;

/**
 * Heuristic name extraction.
 * Strategy:
 *   1. Look for a 2-4 word sequence of capitalized words in the first 20 lines
 *      that isn't a blacklisted section header.
 *   2. Prefer the line immediately before the email address.
 *   3. Strip honorifics.
 */
function extractName(text) {
  const lines = text
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .slice(0, 30); // only check first 30 lines

  const email = extractEmail(text);
  const emailLineIdx = email ? lines.findIndex(l => l.toLowerCase().includes(email.toLowerCase())) : -1;

  // Helper: score a candidate name string
  function scoreCandidate(candidate) {
    const lower = candidate.toLowerCase().trim();
    if (!lower || lower.length < 2) return 0;
    if (NAME_BLACKLIST.has(lower)) return 0;
    const words = lower.split(/\s+/).filter(w => w.length > 0);
    if (words.length < 1 || words.length > 5) return 0;
    // All words should start with capital (check original)
    const origWords = candidate.trim().split(/\s+/);
    const allCap = origWords.every(w => /^[A-Z]/.test(w));
    if (!allCap) return 0;
    // Penalise if any word is a common non-name word
    if (words.some(w => NAME_BLACKLIST.has(w))) return 0;
    // Penalise very short words (except initials like "A.")
    const tooShort = words.filter(w => w.length < 2 && !SINGLE_LETTERS.test(w));
    if (tooShort.length > 0) return 0;
    let score = 10;
    if (words.length >= 2) score += 5;
    if (words.length === 3) score += 3;
    return score;
  }

  // Strategy 1: line before email
  if (emailLineIdx > 0) {
    const before = lines[emailLineIdx - 1];
    if (scoreCandidate(before) > 0) {
      return cleanName(before);
    }
  }

  // Strategy 2: scan first 10 lines for a name-like line
  for (let i = 0; i < Math.min(10, lines.length); i++) {
    const line = lines[i];
    // Skip lines with common patterns (phone numbers, emails, URLs, dates)
    if (/[@\d\/\|•|–|\-{2,}]/.test(line)) continue;
    if (/http|www\.|linkedin|github/i.test(line)) continue;
    if (scoreCandidate(line) >= 10) {
      return cleanName(line);
    }
  }

  // Strategy 3: regex scan for 2-3 capitalised words in first 500 chars
  const head = text.slice(0, 500);
  const cap2to3 = /\b([A-Z][a-z]{1,20})\s+([A-Z][a-z]{1,20})(?:\s+([A-Z][a-z]{1,20}))?\b/g;
  let m;
  while ((m = cap2to3.exec(head)) !== null) {
    const candidate = m[0];
    if (scoreCandidate(candidate) >= 10 && !NAME_BLACKLIST.has(candidate.toLowerCase())) {
      return cleanName(candidate);
    }
  }

  return null;
}

function cleanName(raw) {
  const words = raw.trim().split(/\s+/);
  const stripped = words.filter(w => !HONORIFICS.has(w.toLowerCase().replace('.', '')));
  return stripped.join(' ') || raw.trim();
}

// ── Location / City ────────────────────────────────────────────────────────────

// Major cities by region — ordered roughly by population / CV frequency
const CITIES = [
  // India
  'Mumbai', 'Delhi', 'Bangalore', 'Bengaluru', 'Hyderabad', 'Chennai', 'Kolkata',
  'Pune', 'Ahmedabad', 'Jaipur', 'Surat', 'Lucknow', 'Kochi', 'Cochin', 'Coimbatore',
  'Indore', 'Bhopal', 'Nagpur', 'Patna', 'Vadodara', 'Chandigarh', 'Gurgaon', 'Gurugram',
  'Noida', 'Faridabad', 'Ghaziabad', 'Meerut', 'Visakhapatnam', 'Vizag', 'Bhubaneswar',
  'Thiruvananthapuram', 'Trivandrum', 'Mysuru', 'Mysore', 'Mangalore', 'Nashik', 'Aurangabad',
  // UAE / GCC
  'Dubai', 'Abu Dhabi', 'Sharjah', 'Ajman', 'Riyadh', 'Jeddah', 'Dammam',
  'Kuwait City', 'Doha', 'Manama', 'Muscat',
  // UK
  'London', 'Manchester', 'Birmingham', 'Leeds', 'Glasgow', 'Liverpool', 'Bristol',
  'Edinburgh', 'Sheffield', 'Cambridge', 'Oxford',
  // USA
  'New York', 'San Francisco', 'Los Angeles', 'Chicago', 'Seattle', 'Austin', 'Boston',
  'Dallas', 'Houston', 'Atlanta', 'Washington DC', 'San Jose', 'Denver', 'Miami',
  // Canada
  'Toronto', 'Vancouver', 'Montreal', 'Calgary', 'Ottawa',
  // Australia
  'Sydney', 'Melbourne', 'Brisbane', 'Perth', 'Adelaide',
  // Singapore / APAC
  'Singapore', 'Hong Kong', 'Kuala Lumpur', 'Bangkok', 'Jakarta', 'Manila',
  'Tokyo', 'Osaka', 'Seoul', 'Beijing', 'Shanghai', 'Shenzhen',
  // Europe
  'Berlin', 'Paris', 'Amsterdam', 'Zurich', 'Frankfurt', 'Vienna', 'Stockholm',
  'Madrid', 'Barcelona', 'Rome', 'Milan', 'Dublin', 'Lisbon', 'Prague', 'Warsaw',
];

// Countries
const COUNTRIES = [
  'India', 'United Arab Emirates', 'UAE', 'United States', 'USA', 'United Kingdom', 'UK',
  'Canada', 'Australia', 'Singapore', 'Germany', 'France', 'Netherlands', 'Ireland',
  'Saudi Arabia', 'Qatar', 'Kuwait', 'Bahrain', 'Oman', 'New Zealand', 'Sweden',
  'Switzerland', 'Malaysia', 'Hong Kong', 'Japan', 'South Korea', 'China',
];

/**
 * Detect location (city + country) from text.
 * Returns { city, country } with nulls when not found.
 */
function extractLocation(text) {
  const result = { city: null, country: null };

  // Country detection
  for (const country of COUNTRIES) {
    const pattern = new RegExp(`\\b${escapeRegex(country)}\\b`, 'i');
    if (pattern.test(text)) {
      result.country = country === 'UAE' ? 'United Arab Emirates' : country;
      break;
    }
  }

  // City detection — longer names first to avoid partial matches
  const sortedCities = [...CITIES].sort((a, b) => b.length - a.length);
  for (const city of sortedCities) {
    const pattern = new RegExp(`\\b${escapeRegex(city)}\\b`, 'i');
    if (pattern.test(text)) {
      result.city = city;
      break;
    }
  }

  return result;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Experience Years ───────────────────────────────────────────────────────────

const EXPERIENCE_PATTERNS = [
  // "6+ years of experience", "over 5 years experience"
  /(\d+(?:\.\d+)?)\+?\s*(?:years?|yrs?)\s+(?:of\s+)?(?:professional\s+)?(?:work\s+)?experience/gi,
  // "experience of 6 years"
  /experience\s+of\s+(\d+(?:\.\d+)?)\+?\s*(?:years?|yrs?)/gi,
  // "6 years in software development"
  /(\d+(?:\.\d+)?)\+?\s*(?:years?|yrs?)\s+in\s+\w/gi,
  // "total experience: 6 years"
  /total\s+(?:work\s+)?experience[:\s]+(\d+(?:\.\d+)?)\+?\s*(?:years?|yrs?)/gi,
  // "work experience: 6+ years"
  /work\s+experience[:\s]+(\d+(?:\.\d+)?)\+?\s*(?:years?|yrs?)/gi,
];

/**
 * Detect stated years of experience from the resume text.
 * Returns highest plausible number found, or null.
 */
function extractYearsOfExperience(text) {
  const values = [];
  for (const pattern of EXPERIENCE_PATTERNS) {
    let m;
    while ((m = pattern.exec(text)) !== null) {
      const val = parseFloat(m[1]);
      if (val >= 0 && val <= 60) values.push(val);
    }
  }
  if (values.length === 0) return null;
  // Return the maximum (e.g. "over 10 years" beats "2 years at company X")
  return Math.max(...values);
}

// ── Education Degrees ──────────────────────────────────────────────────────────

const DEGREE_PATTERNS = [
  { pattern: /\bph\.?d\.?\b/gi,                                    label: 'PhD' },
  { pattern: /\bm\.?b\.?a\.?\b/gi,                                 label: 'MBA' },
  { pattern: /\bm\.?tech\.?\b|\bm\.?e\.?\b(?!chanical)/gi,         label: 'M.Tech' },
  { pattern: /\bm\.?sc\.?\b|master(?:s)?\s+of\s+science/gi,        label: 'MSc' },
  { pattern: /\bm\.?a\.?\b|master(?:s)?\s+of\s+arts/gi,            label: 'MA' },
  { pattern: /\bm\.?com\.?\b|master(?:s)?\s+of\s+commerce/gi,      label: 'MCom' },
  { pattern: /\bb\.?tech\.?\b|\bb\.?e\.?\b(?!ngl)/gi,              label: 'B.Tech' },
  { pattern: /\bb\.?sc\.?\b|bachelor(?:s)?\s+of\s+science/gi,      label: 'BSc' },
  { pattern: /\bb\.?com\.?\b|bachelor(?:s)?\s+of\s+commerce/gi,    label: 'BCom' },
  { pattern: /\bb\.?b\.?a\.?\b|bachelor(?:s)?\s+of\s+business/gi,  label: 'BBA' },
  { pattern: /\bb\.?a\.?\b|bachelor(?:s)?\s+of\s+arts/gi,          label: 'BA' },
  { pattern: /\bdiploma\b/gi,                                       label: 'Diploma' },
  { pattern: /\bhigh\s+school\b|12th|class\s+xii|a\s+levels\b/gi,  label: 'High School' },
  { pattern: /\bllb\b|bachelor\s+of\s+law/gi,                       label: 'LLB' },
  { pattern: /\bmbbs\b/gi,                                          label: 'MBBS' },
  { pattern: /\bbds\b/gi,                                           label: 'BDS' },
  { pattern: /\bca\b|chartered\s+accountant/gi,                     label: 'CA' },
  { pattern: /\bcma\b|cost\s+(?:management\s+)?accountant/gi,       label: 'CMA' },
  { pattern: /\bcs\b|company\s+secretary/gi,                        label: 'CS' },
];

/**
 * Detect education degrees from resume text.
 * Returns array of unique detected degree labels.
 */
function extractEducation(text) {
  const found = new Set();
  for (const { pattern, label } of DEGREE_PATTERNS) {
    if (pattern.test(text)) found.add(label);
    pattern.lastIndex = 0; // reset regex state
  }
  return [...found];
}


// ── Industry Detection ─────────────────────────────────────────────────────────

/**
 * Map detected keywords to the exact industry values used in the frontend dropdown.
 * Order matters — more specific entries first.
 */
const INDUSTRY_KEYWORDS = [
  // Finance & Banking
  {
    industry: 'Finance & Banking',
    keywords: [
      'accountant', 'accounting', 'finance', 'banking', 'financial', 'auditor', 'audit',
      'tax', 'gst', 'tds', 'tally', 'zoho books', 'quickbooks', 'chartered accountant',
      'investment', 'equity', 'credit', 'loan', 'insurance', 'actuary', 'treasury',
      'bookkeeping', 'payroll', 'accounts payable', 'accounts receivable', 'budgeting',
      'forecasting', 'financial reporting', 'bank reconciliation', 'p&l', 'balance sheet',
    ],
  },
  // Healthcare
  {
    industry: 'Healthcare',
    keywords: [
      'doctor', 'physician', 'nurse', 'nursing', 'hospital', 'clinic', 'medical',
      'healthcare', 'pharmacist', 'pharmacy', 'surgeon', 'mbbs', 'bds', 'patient',
      'clinical', 'radiology', 'physiotherapy', 'dental', 'health care',
    ],
  },
  // Technology & Software
  {
    industry: 'Technology & Software',
    keywords: [
      'software', 'developer', 'engineer', 'programming', 'coding', 'python', 'java',
      'javascript', 'react', 'node', 'typescript', 'cloud', 'devops', 'aws', 'azure',
      'kubernetes', 'docker', 'machine learning', 'data science', 'artificial intelligence',
      'cybersecurity', 'database', 'api', 'backend', 'frontend', 'fullstack', 'it',
      'information technology', 'tech', 'saas', 'product manager', 'agile', 'scrum',
    ],
  },
  // Education
  {
    industry: 'Education',
    keywords: [
      'teacher', 'teaching', 'professor', 'lecturer', 'school', 'college', 'university',
      'academic', 'curriculum', 'education', 'training', 'tutor', 'faculty',
      'e-learning', 'instructional', 'pedagogy', 'student affairs',
    ],
  },
  // Consulting
  {
    industry: 'Consulting',
    keywords: [
      'consultant', 'consulting', 'advisory', 'management consulting', 'strategy',
      'mckinsey', 'deloitte', 'pwc', 'kpmg', 'ernst', 'accenture', 'business analyst',
      'process improvement', 'change management', 'transformation',
    ],
  },
  // Manufacturing
  {
    industry: 'Manufacturing',
    keywords: [
      'manufacturing', 'production', 'factory', 'plant', 'quality control', 'quality assurance',
      'supply chain', 'procurement', 'inventory', 'logistics', 'warehouse', 'operations',
      'lean', 'six sigma', 'industrial', 'mechanical', 'electrical engineer',
    ],
  },
  // Retail & E-commerce
  {
    industry: 'Retail & E-commerce',
    keywords: [
      'retail', 'e-commerce', 'ecommerce', 'sales', 'merchandising', 'store', 'shopify',
      'amazon', 'flipkart', 'buyer', 'category management', 'fmcg', 'consumer goods',
    ],
  },
  // Media & Entertainment
  {
    industry: 'Media & Entertainment',
    keywords: [
      'media', 'entertainment', 'journalist', 'editor', 'content', 'publishing',
      'advertising', 'marketing', 'public relations', 'pr ', 'social media', 'film',
      'television', 'broadcast', 'graphic designer', 'creative', 'copywriter',
    ],
  },
  // Telecom
  {
    industry: 'Telecom',
    keywords: [
      'telecom', 'telecommunications', 'network engineer', 'rf engineer', 'bts',
      'jio', 'airtel', 'vodafone', 'bsnl', 'tower', 'spectrum', 'fiber', '5g', '4g',
    ],
  },
  // Real Estate
  {
    industry: 'Real Estate',
    keywords: [
      'real estate', 'property', 'realty', 'construction', 'civil engineer', 'architect',
      'urban planning', 'facility management', 'valuation', 'mortgage',
    ],
  },
  // Government
  {
    industry: 'Government / Public Sector',
    keywords: [
      'government', 'public sector', 'civil service', 'ias', 'ips', 'upsc', 'municipal',
      'ministry', 'defence', 'army', 'navy', 'air force', 'police', 'ngo',
    ],
  },
];

/**
 * Detect industry from resume text by scoring keyword matches.
 * Returns the exact string value expected by the frontend dropdown, or null.
 *
 * @param {string} text
 * @returns {string|null}
 */
function extractIndustry(text) {
  const lower = text.toLowerCase();
  let best = null;
  let bestScore = 0;

  for (const { industry, keywords } of INDUSTRY_KEYWORDS) {
    let score = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = industry;
    }
  }

  return bestScore >= 1 ? best : null;
}

// ── Education Level Detection ──────────────────────────────────────────────────

/**
 * Map detected degree patterns to the exact education level values
 * used in the frontend dropdown.
 *
 * Priority order: highest degree first.
 */
const EDUCATION_LEVEL_MAP = [
  { level: 'PhD',                     patterns: [/\bph\.?d\.?\b/i, /\bdoctor(?:ate|al)\b/i] },
  { level: 'MBA',                     patterns: [/\bm\.?b\.?a\.?\b/i, /master\s+of\s+business/i] },
  { level: 'Master\'s Degree',       patterns: [/\bm\.?tech\.?\b/i, /\bm\.?sc\.?\b/i, /\bm\.?e\.?\b/i, /\bm\.?a\.?\b/i, /\bm\.?com\.?\b/i, /\bmaster\b/i, /\bpg\s+diploma\b/i, /\bpost\s*grad/i] },
  { level: 'Professional Certification', patterns: [/\bca\b/i, /chartered\s+accountant/i, /\bcma\b/i, /\bcpa\b/i, /\bcs\b.*company\s+secretary/i, /\bllb\b/i, /\bmbbs\b/i, /\bbds\b/i] },
  { level: 'Bachelor\'s Degree',     patterns: [/\bb\.?tech\.?\b/i, /\bb\.?e\.?\b/i, /\bb\.?sc\.?\b/i, /\bb\.?com\.?\b/i, /\bb\.?b\.?a\.?\b/i, /\bb\.?a\.?\b/i, /\bbachelor/i] },
  { level: 'Diploma',                 patterns: [/\bdiploma\b/i, /\bpoly\s*technic\b/i, /\bitu\b/i] },
  { level: 'High School',             patterns: [/\bhigh\s+school\b/i, /\b12th\b/i, /\bclass\s+xii\b/i, /\ba\s+levels\b/i, /\bhsc\b/i, /\bsslc\b/i, /\b10th\b/i] },
];

/**
 * Detect highest education level from resume text.
 * Returns the exact string value expected by the frontend dropdown, or null.
 *
 * @param {string} text
 * @returns {string|null}
 */
function extractEducationLevel(text) {
  // Walk the list top-to-bottom (highest degree first) and return first match
  for (const { level, patterns } of EDUCATION_LEVEL_MAP) {
    for (const pattern of patterns) {
      if (pattern.test(text)) return level;
    }
  }
  return null;
}

module.exports = {
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
};








