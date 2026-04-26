'use strict';

/**
 * @file src/services/ai/providers/anthropic.js
 * @description
 * Anthropic Claude resume extraction provider (priority 5 — last resort).
 *
 * Reuses the project's existing Anthropic client pattern from
 * src/services/providers/claudeService.js, adapted for structured
 * resume extraction:
 *   - Lazy singleton SDK client
 *   - Memoized API key (env-first)
 *   - AbortController-based timeout
 *   - claude-haiku-3 for speed + cost efficiency
 *   - Strict JSON-only system prompt
 *   - Safe JSON parsing
 */

const logger = require('../../../utils/logger');

// ── Optional SDK ───────────────────────────────────────────────────────────────
let Anthropic = null;
try {
  Anthropic = require('@anthropic-ai/sdk');
} catch { /* SDK not installed */ }

// ── Optional secrets module ────────────────────────────────────────────────────
let getSecret = null;
try {
  ({ getSecret } = require('../../../modules/secrets'));
} catch { /* env-only fallback */ }

// ── Constants ─────────────────────────────────────────────────────────────────
const PROVIDER_NAME  = 'anthropic';
const DEFAULT_MODEL  = 'claude-haiku-4-5-20251001'; // Fast + affordable
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

// ── Singleton state ────────────────────────────────────────────────────────────
let _cachedApiKey  = null;
let _clientPromise = null;

async function resolveApiKey() {
  if (_cachedApiKey) return _cachedApiKey;

  const envKey = process.env.ANTHROPIC_API_KEY;
  if (envKey && typeof envKey === 'string' && envKey.trim()) {
    _cachedApiKey = envKey.trim();
    return _cachedApiKey;
  }

  if (typeof getSecret === 'function') {
    const secret = await getSecret('ANTHROPIC_API_KEY').catch(() => null);
    if (secret && typeof secret === 'string' && secret.trim()) {
      _cachedApiKey = secret.trim();
      return _cachedApiKey;
    }
  }

  return null;
}

async function getClient() {
  if (!Anthropic) {
    throw new Error(
      '[Anthropic] @anthropic-ai/sdk is not installed. Run: npm install @anthropic-ai/sdk'
    );
  }

  if (_clientPromise) return _clientPromise;

  _clientPromise = (async () => {
    const apiKey = await resolveApiKey();
    if (!apiKey) throw new Error('[Anthropic] ANTHROPIC_API_KEY is not configured');
    return new Anthropic({ apiKey });
  })();

  try {
    return await _clientPromise;
  } catch (err) {
    _clientPromise = null;
    _cachedApiKey  = null;
    throw err;
  }
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('[Anthropic] Request timed out')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
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
 * Extract resume fields using Anthropic Claude.
 *
 * @param {string} resumeText
 * @returns {Promise<object|null>}
 */
async function extractResume(resumeText) {
  const startedAt = Date.now();

  try {
    const client = await getClient();

    const result = await withTimeout(
      client.messages.create({
        model:      DEFAULT_MODEL,
        max_tokens: MAX_TOKENS,
        system:     SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: resumeText },
        ],
      }),
      TIMEOUT_MS
    );

    // Claude returns content as an array of blocks
    const rawText = (result?.content ?? [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    if (!rawText) throw new Error('[Anthropic] Empty response body');

    const parsed = safeParseJson(rawText);
    if (!parsed) throw new Error('[Anthropic] Failed to parse JSON response');

    logger.info('[AIProviderManager] Anthropic extraction success', {
      provider:     PROVIDER_NAME,
      model:        DEFAULT_MODEL,
      latency_ms:   Date.now() - startedAt,
      skills:       (parsed.skills     ?? []).length,
      experience:   (parsed.experience ?? []).length,
    });

    return {
      name:       parsed.name       ?? null,
      email:      parsed.email      ?? null,
      skills:     Array.isArray(parsed.skills)     ? parsed.skills     : [],
      experience: Array.isArray(parsed.experience) ? parsed.experience : [],
      education:  Array.isArray(parsed.education)  ? parsed.education  : [],
    };

  } catch (err) {
    logger.error('[AIProviderManager] Anthropic extraction failed', {
      provider:   PROVIDER_NAME,
      latency_ms: Date.now() - startedAt,
      error:      err.message,
    });
    return null;
  }
}

module.exports = { extractResume, PROVIDER_NAME };