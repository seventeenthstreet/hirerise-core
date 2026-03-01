import { Storage } from '@google-cloud/storage';
import { logger } from '../../../shared/logger/index.js';

const storage = new Storage();

/**
 * Fetches resume from Cloud Storage and extracts structured sections.
 * In production, integrate with Document AI or a dedicated parsing service.
 * This implementation handles plain text with section header detection.
 *
 * @param {string} storagePath - gs://bucket/path or bucket/path format
 * @param {string} mimeType
 * @returns {ParsedResume}
 */
export async function parseResume(storagePath, mimeType) {
  const rawText = await fetchFromStorage(storagePath);
  return extractStructure(rawText, mimeType);
}

async function fetchFromStorage(storagePath) {
  const path = storagePath.replace(/^gs:\/\/[^/]+\//, '');
  const bucketName = process.env.RESUME_STORAGE_BUCKET;

  if (!bucketName) throw new Error('RESUME_STORAGE_BUCKET env var not set');

  const [content] = await storage.bucket(bucketName).file(path).download();
  return content.toString('utf-8');
}

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
    rawText: text.slice(0, 50000), // cap for safety
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
