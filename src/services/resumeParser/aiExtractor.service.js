'use strict';

const logger = require('../../utils/logger');

const MAX_RESUME_TEXT_LENGTH = 12000;
const OPENAI_MODEL = 'gpt-4o-mini';

const SYSTEM_PROMPT = `You are a precise resume data extractor.
Extract structured information from the resume text provided.
Return ONLY a valid JSON object — no preamble, no markdown fences, no explanation.

The JSON must follow this exact schema:
{
  "name": "string or null",
  "email": "string or null",
  "phone": "string or null",
  "location": "string or null",
  "summary": "string or null",
  "skills": ["string", ...],
  "experience": [
    {
      "title": "string",
      "company": "string",
      "start_date": "string or null",
      "end_date": "string or null",
      "description": "string or null"
    }
  ],
  "education": [
    {
      "degree": "string",
      "institution": "string",
      "startYear": "number or null",
      "endYear": "number or null"
    }
  ]
}`;

function isWeakParse(structuredResume) {
  if (!structuredResume || typeof structuredResume !== 'object') return true;

  const skillsCount     = structuredResume?.skills?.length ?? 0;
  const experienceCount = structuredResume?.experience?.length ?? 0;

  return skillsCount < 3 || experienceCount < 1;
}

function getParseConfidence(sr) {
  let score = 0;
  if (sr?.core?.email) score += 1;
  if ((sr?.skills?.length ?? 0) >= 3) score += 1;
  if ((sr?.experience?.length ?? 0) >= 1) score += 1;
  return score;
}

async function extractWithAI(resumeText) {
  if (!resumeText || typeof resumeText !== 'string') return null;

  logger.info('[AIExtractor] Starting AI extraction');

  /* =========================
     🔹 PROVIDER MANAGER PATH
  ========================= */
  try {
    const { extractResumeWithFallback } = require('../ai');
    const result = await extractResumeWithFallback(resumeText);

    if (result) {
      logger.info('[AIExtractor] Provider manager success');

      return {
        ...result,
        isTruncated: false, // 🔥 FIX
      };
    }
  } catch (err) {
    logger.warn('[AIExtractor] Provider manager failed', {
      error: err.message,
    });
  }

  /* =========================
     🔹 DIRECT OPENAI FALLBACK
  ========================= */
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.error('[AIExtractor] Missing OPENAI_API_KEY');
    return null;
  }

  let isTruncated = false;
  let truncatedText = resumeText;

  if (resumeText.length > MAX_RESUME_TEXT_LENGTH) {
    isTruncated = true;

    const head = Math.floor(MAX_RESUME_TEXT_LENGTH * 0.7);
    const tail = MAX_RESUME_TEXT_LENGTH - head;

    truncatedText =
      resumeText.slice(0, head) +
      '\n...[truncated]...\n' +
      resumeText.slice(-tail);

    logger.warn('[AIExtractor] Resume truncated for AI processing', {
      originalLength: resumeText.length,
      truncatedLength: truncatedText.length,
      strategy: 'head_tail',
    });
  }

  let rawContent = '';

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0,
        max_tokens: 1500,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: truncatedText },
        ],
      }),
    });

    const json = await response.json();
    rawContent = json?.choices?.[0]?.message?.content ?? '';
  } catch (err) {
    logger.error('[AIExtractor] OpenAI request failed', {
      error: err.message,
    });
    return null;
  }

  /* =========================
     🔹 SAFE JSON PARSE
  ========================= */
  try {
    const cleaned = rawContent
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/, '')
      .replace(/```\s*$/, '')
      .trim();

    const parsed = JSON.parse(cleaned);

    return {
      name: parsed.name ?? null,
      email: parsed.email ?? null,
      phone: parsed.phone ?? null,
      location: parsed.location ?? null,
      summary: parsed.summary ?? null,
      skills: Array.isArray(parsed.skills) ? parsed.skills : [],
      experience: Array.isArray(parsed.experience)
        ? parsed.experience
        : [],
      education: Array.isArray(parsed.education)
        ? parsed.education
        : [],
      isTruncated, // 🔥 FIX
    };
  } catch (err) {
    logger.error('[AIExtractor] JSON parse failed', {
      error: err.message,
    });
    return null;
  }
}

function mergeAIWithStructured(base, ai) {
  if (!base || !ai) return base;

  base.core = base.core || {};

  if (!base.core.fullName && ai.name) base.core.fullName = ai.name;
  if (!base.core.email && ai.email) base.core.email = ai.email;
  if (!base.core.phone && ai.phone) base.core.phone = ai.phone;
  if (!base.core.location && ai.location)
    base.core.location = ai.location;
  if (!base.core.summary && ai.summary)
    base.core.summary = ai.summary;

  if ((base.skills?.length ?? 0) < 1 && ai.skills?.length) {
    base.skills = ai.skills.map((s) => ({ name: s }));
  }

  if ((base.experience?.length ?? 0) === 0 && ai.experience?.length) {
    base.experience = ai.experience;
  }

  if ((base.education?.length ?? 0) === 0 && ai.education?.length) {
    base.education = ai.education;
  }

  return base;
}

module.exports = {
  isWeakParse,
  getParseConfidence,
  extractWithAI,
  mergeAIWithStructured,
};