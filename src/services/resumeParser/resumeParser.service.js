'use strict';

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