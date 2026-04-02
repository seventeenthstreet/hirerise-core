import { createClient } from '@supabase/supabase-js';
import { logger } from '../../../shared/logger/index.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * Parse resume from Supabase Storage
 */
export async function parseResume(storagePath, mimeType) {
  const rawText = await fetchFromStorage(storagePath);
  return extractStructure(rawText, mimeType);
}

async function fetchFromStorage(storagePath) {
  const bucket = process.env.RESUME_STORAGE_BUCKET;

  if (!bucket) {
    throw new Error('RESUME_STORAGE_BUCKET env var not set');
  }

  const { data, error } = await supabase.storage
    .from(bucket)
    .download(storagePath);

  if (error) {
    logger.error('Storage fetch failed', { error });
    throw new Error(`Storage fetch failed: ${error.message}`);
  }

  const text = await data.text();
  return text;
}

/* =========================
   EXISTING LOGIC (UNCHANGED)
========================= */

function extractStructure(text, mimeType) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const sections = classifySections(lines);
  const skills = extractSkills(sections.skills ?? []);
  const wordCount = text.split(/\s+/).length;
  const totalYearsExperience = estimateYearsExperience(sections.experience ?? []);

  return {
    rawText: text.slice(0, 50000),
    sections,
    skills,
    metadata: {
      wordCount,
      lineCount: lines.length,
      totalYearsExperience,
      mimeType,
      parsedAt: new Date().toISOString(),
    },
  };
}

const SECTION_HEADERS = {
  experience: /^(work\s+)?experience|employment|work\s+history/i,
  education: /^education|academic|qualifications/i,
  skills: /^(technical\s+)?skills|competencies|technologies/i,
  summary: /^summary|objective|profile|about/i,
  certifications: /^certifications?|licenses?|credentials/i,
  projects: /^projects?|portfolio/i,
  contact: /^contact|personal\s+info/i,
};

function classifySections(lines) {
  const sections = {};
  let currentSection = 'other';

  for (const line of lines) {
    let matched = false;

    for (const [name, pattern] of Object.entries(SECTION_HEADERS)) {
      if (pattern.test(line) && line.length < 60) {
        currentSection = name;
        if (!sections[currentSection]) sections[currentSection] = [];
        matched = true;
        break;
      }
    }

    if (!matched) {
      if (!sections[currentSection]) sections[currentSection] = [];
      sections[currentSection].push(line);
    }
  }

  return sections;
}

function extractSkills(skillLines) {
  const raw = skillLines.join(' ');

  return raw
    .split(/[,|•·/\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1 && s.length < 60)
    .slice(0, 100);
}

function estimateYearsExperience(experienceLines) {
  const yearPattern = /\b(19|20)\d{2}\b/g;
  const years = [];

  for (const line of experienceLines) {
    const matches = line.match(yearPattern);
    if (matches) years.push(...matches.map(Number));
  }

  if (years.length < 2) return null;

  return Math.max(...years) - Math.min(...years);
}