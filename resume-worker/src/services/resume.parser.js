import { createClient } from '@supabase/supabase-js';
import { logger } from '../../../shared/logger/index.js';

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
export async function parseResume(storagePath, mimeType) {
  if (!storagePath || typeof storagePath !== 'string') {
    throw new Error('Invalid storagePath');
  }

  const rawText = await fetchFromStorage(storagePath);
  return extractStructure(rawText, mimeType);
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

  const text = String(await data.text()).slice(0, MAX_TEXT_LENGTH);
  return text;
}

/* =========================
   EXISTING LOGIC (SAFE + OPTIMIZED)
========================= */

function extractStructure(text, mimeType) {
  const safeText = String(text ?? '').slice(0, MAX_TEXT_LENGTH);

  const lines = safeText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const sections = classifySections(lines);
  const skills = extractSkills(sections.skills ?? []);
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
    },
  };
}

const SECTION_HEADERS = Object.freeze({
  experience:
    /^(?:(?:work\s+)?experience|employment|work\s+history)$/i,
  education:
    /^(?:education|academic|qualifications)$/i,
  skills:
    /^(?:(?:technical\s+)?skills|competencies|technologies)$/i,
  summary:
    /^(?:summary|objective|profile|about)$/i,
  certifications:
    /^(?:certifications?|licenses?|credentials)$/i,
  projects:
    /^(?:projects?|portfolio)$/i,
  contact:
    /^(?:contact|personal\s+info)$/i,
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

  for (const line of skillLines) {
    const tokens = String(line)
      .split(/[,|•·/\n]+/)
      .map((skill) => skill.trim().toLowerCase())
      .filter(
        (skill) => skill.length > 1 && skill.length < 60
      );

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