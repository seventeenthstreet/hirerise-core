'use strict';

/**
 * @file src/services/ai/providers/openai.js
 * @description
 * OpenAI resume extraction provider (priority 4).
 *
 * Uses the OpenAI REST API directly (no SDK dependency) with:
 *   - Memoized API key (env-first)
 *   - AbortController-based timeout
 *   - gpt-4o-mini for cost efficiency
 *   - Strict JSON-only system prompt
 *   - Safe JSON parsing
 */

const logger = require('../../../utils/logger');

// ── Optional secrets module ────────────────────────────────────────────────────
let getSecret = null;
try {
  ({ getSecret } = require('../../../modules/secrets'));
} catch { /* env-only fallback */ }

// ── Constants ─────────────────────────────────────────────────────────────────
const PROVIDER_NAME  = 'openai';
const OPENAI_URL     = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL  = 'gpt-4o-mini';
const TIMEOUT_MS     = 20_000;
const MAX_TOKENS     = 1500;

const SYSTEM_PROMPT = `You are a precise resume data extractor.
Extract structured information from the resume text provided.
Return ONLY a valid JSON object — no preamble, no markdown fences, no explanation.

The JSON must follow this exact schema:
{
  "name": "string or null",
  "email": "string or null",
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
}

Rules:
- skills must be an array of plain strings
- experience and education must be arrays (empty if not found)
- If a field cannot be found, use null
- Do NOT invent data not present in the resume text`;

// ── Singleton key cache ────────────────────────────────────────────────────────
let _cachedApiKey = null;

async function resolveApiKey() {
  if (_cachedApiKey) return _cachedApiKey;

  const envKey = process.env.OPENAI_API_KEY;
  if (envKey && typeof envKey === 'string' && envKey.trim()) {
    _cachedApiKey = envKey.trim();
    return _cachedApiKey;
  }

  if (typeof getSecret === 'function') {
    const secret = await getSecret('OPENAI_API_KEY').catch(() => null);
    if (secret && typeof secret === 'string' && secret.trim()) {
      _cachedApiKey = secret.trim();
      return _cachedApiKey;
    }
  }

  return null;
}

function safeParseJson(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/,      '')
    .replace(/```\s*$/,      '')
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Extract resume fields using OpenAI.
 *
 * @param {string} resumeText
 * @returns {Promise<object|null>}
 */
async function extractResume(resumeText) {
  const startedAt = Date.now();

  try {
    const apiKey = await resolveApiKey();
    if (!apiKey) throw new Error('[OpenAI] OPENAI_API_KEY is not configured');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let response;
    try {
      response = await fetch(OPENAI_URL, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model:       DEFAULT_MODEL,
          temperature: 0,
          max_tokens:  MAX_TOKENS,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user',   content: resumeText },
          ],
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => '(no body)');
      throw new Error(
        `[OpenAI] HTTP ${response.status}: ${errBody.slice(0, 200)}`
      );
    }

    const json    = await response.json();
    const rawText = json?.choices?.[0]?.message?.content ?? '';

    if (!rawText) throw new Error('[OpenAI] Empty response body');

    const parsed = safeParseJson(rawText);
    if (!parsed) throw new Error('[OpenAI] Failed to parse JSON response');

    logger.info('[AIProviderManager] OpenAI extraction success', {
      provider:   PROVIDER_NAME,
      model:      DEFAULT_MODEL,
      latency_ms: Date.now() - startedAt,
      skills:     (parsed.skills     ?? []).length,
      experience: (parsed.experience ?? []).length,
    });

    return {
      name:       parsed.name       ?? null,
      email:      parsed.email      ?? null,
      skills:     Array.isArray(parsed.skills)     ? parsed.skills     : [],
      experience: Array.isArray(parsed.experience) ? parsed.experience : [],
      education:  Array.isArray(parsed.education)  ? parsed.education  : [],
    };

  } catch (err) {
    logger.error('[AIProviderManager] OpenAI extraction failed', {
      provider:   PROVIDER_NAME,
      latency_ms: Date.now() - startedAt,
      error:      err.message,
    });
    return null;
  }
}

module.exports = { extractResume, PROVIDER_NAME };