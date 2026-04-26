'use strict';

/**
 * Gemini Resume Extraction Provider (PRODUCTION READY)
 */

const logger = require('../../../utils/logger');

let GoogleGenerativeAI = null;
try {
  ({ GoogleGenerativeAI } = require('@google/generative-ai'));
} catch {
  // SDK missing — handled later
}

let getSecret = null;
try {
  ({ getSecret } = require('../../../modules/secrets'));
} catch {}

/* ---------------- CONFIG ---------------- */

const PROVIDER_NAME = 'gemini';
const PRIMARY_MODEL = 'gemini-1.5-flash';
const FALLBACK_MODEL = 'gemini-1.5-flash-latest';
const TIMEOUT_MS = 20000;
const MAX_INPUT_CHARS = 5000;

/* ---------------- PROMPT ---------------- */

const SYSTEM_INSTRUCTION = `You are a precise resume data extractor.

Return ONLY valid JSON. No explanation. No markdown.

{
  "name": "",
  "email": "",
  "skills": [],
  "experience": [
    {
      "title": "",
      "company": "",
      "start_date": "",
      "end_date": "",
      "description": ""
    }
  ],
  "education": []
}

Rules:
- skills must be array of strings
- experience must include ALL jobs + internships
- do NOT skip information
- do NOT hallucinate`;

/* ---------------- STATE ---------------- */

let cachedKey = null;
let clientPromise = null;

/* ---------------- HELPERS ---------------- */

async function resolveApiKey() {
  if (cachedKey) return cachedKey;

  const envKey = process.env.GEMINI_API_KEY;
  if (envKey?.trim()) {
    cachedKey = envKey.trim();
    return cachedKey;
  }

  if (typeof getSecret === 'function') {
    const secret = await getSecret('GEMINI_API_KEY').catch(() => null);
    if (secret?.trim()) {
      cachedKey = secret.trim();
      return cachedKey;
    }
  }

  return null;
}

async function getClient() {
  if (!GoogleGenerativeAI) {
    throw new Error('Gemini SDK not installed');
  }

  if (clientPromise) return clientPromise;

  clientPromise = (async () => {
    const key = await resolveApiKey();
    if (!key) throw new Error('GEMINI_API_KEY missing');
    return new GoogleGenerativeAI(key);
  })();

  return clientPromise;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Gemini timeout')), ms)
    ),
  ]);
}

function safeJsonParse(text) {
  if (!text) return null;

  const cleaned = text
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function normalizeResult(parsed) {
  return {
    name: parsed?.name ?? null,
    email: parsed?.email ?? null,
    skills: Array.isArray(parsed?.skills) ? parsed.skills : [],
    experience: Array.isArray(parsed?.experience) ? parsed.experience : [],
    education: Array.isArray(parsed?.education) ? parsed.education : [],
  };
}

/* ---------------- CORE ---------------- */

async function runModel(genAI, modelName, text) {
  const model = genAI.getGenerativeModel({
    model: modelName,
    systemInstruction: SYSTEM_INSTRUCTION,
  });

  const result = await withTimeout(
    model.generateContent(text),
    TIMEOUT_MS
  );

  const raw =
    typeof result?.response?.text === 'function'
      ? result.response.text()
      : '';

  const parsed = safeJsonParse(raw);

  if (!parsed) {
    throw new Error('Invalid JSON response');
  }

  return normalizeResult(parsed);
}

/* ---------------- MAIN ---------------- */

async function extractResume(resumeText) {
  const start = Date.now();

  try {
    const genAI = await getClient();

    // truncate for cost control
    const text = resumeText.slice(0, MAX_INPUT_CHARS);

    console.log('🤖 Gemini: extracting resume...');

    // Try primary model
    try {
      const result = await runModel(genAI, PRIMARY_MODEL, text);

      logger.info('Gemini success (primary)', {
        latency: Date.now() - start,
        skills: result.skills.length,
        exp: result.experience.length,
      });

      return result;
    } catch (err) {
      console.warn('⚠️ Gemini primary failed, trying fallback...', err.message);
    }

    // Fallback model
    const fallbackResult = await runModel(genAI, FALLBACK_MODEL, text);

    logger.info('Gemini success (fallback)', {
      latency: Date.now() - start,
      skills: fallbackResult.skills.length,
      exp: fallbackResult.experience.length,
    });

    return fallbackResult;

  } catch (err) {
    logger.error('Gemini failed completely', {
      error: err.message,
      latency: Date.now() - start,
    });

    return null;
  }
}

module.exports = { extractResume, PROVIDER_NAME };