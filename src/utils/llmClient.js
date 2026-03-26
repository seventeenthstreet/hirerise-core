'use strict';

/**
 * llmClient.js — Real LLM Wrapper
 *
 * Replaces the TODO stub that returned hardcoded growth projections.
 *
 * Responsibility:
 *   Bridge between careerIntelligence.service.js (which has structured
 *   input/output contracts) and aiRouter.js (which handles raw text I/O
 *   across multiple providers).
 *
 * What this file does NOT do:
 *   - Pick providers (aiRouter handles that)
 *   - Handle retries or timeouts (aiRouter handles that)
 *   - Know anything about career intelligence domain logic
 *
 * generate() contract (unchanged from the stub — zero changes needed in callers):
 *   Input:  { systemPrompt: string, input: object, temperature?: number }
 *   Output: Parsed JSON object (the LLM's structured response)
 *
 * Flow:
 *   1. Serialise `input` as indented JSON for LLM readability
 *   2. Combine systemPrompt + serialised input into a single prompt string
 *   3. Call aiRouter.generateAIResponse() — waterfall across all providers
 *   4. Strip markdown fences from the response (all models emit them sometimes)
 *   5. Parse and return the JSON object
 *   6. Throw a descriptive error on parse failure so careerIntelligence.service.js
 *      can surface it cleanly rather than returning garbage to the frontend
 *
 * Provider fallback order (configured in aiRouter.js):
 *   1. OpenRouter (Llama 3.1 70B) — PRIMARY
 *   2. Claude 3 Haiku             — FALLBACK
 *   3. Gemini 1.5 Flash           — BACKUP
 *   4. Fireworks / Llama 3        — EMERGENCY
 *   5. Mistral Small              — LAST RESORT
 */

const { generateAIResponse } = require('../services/aiRouter');
const logger                  = require('./logger');

// ── JSON extraction ───────────────────────────────────────────────────────────

/**
 * stripAndParseJSON(raw) → object
 *
 * Handles the four common LLM output patterns:
 *   a) Pure JSON string
 *   b) ```json\n{...}\n```  (markdown fenced)
 *   c) ```\n{...}\n```      (no language tag)
 *   d) Prose explanation THEN the JSON block
 *
 * Throws a descriptive error if nothing can be parsed so the caller
 * can log it with context and surface a clear error to the frontend.
 */
function stripAndParseJSON(raw) {
  if (!raw || typeof raw !== 'string') {
    throw new Error('[llmClient] LLM returned an empty or non-string response');
  }

  // Remove markdown code fences
  let cleaned = raw
    .replace(/^```(?:json)?\s*/im, '')
    .replace(/\s*```$/im, '')
    .trim();

  // First attempt: the entire cleaned string is valid JSON
  try {
    return JSON.parse(cleaned);
  } catch (_firstErr) {
    // Second attempt: extract the first { } or [ ] block from the string.
    // This handles models that prepend "Here is the JSON:" or similar prose.
    const match = cleaned.match(/([\[{][\s\S]*[\]}])/);
    if (match) {
      try {
        return JSON.parse(match[1]);
      } catch (_secondErr) {
        // fall through to error below
      }
    }

    throw new Error(
      `[llmClient] LLM response could not be parsed as JSON.\n` +
      `First 400 chars of raw response:\n${raw.slice(0, 400)}`
    );
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * generate({ systemPrompt, input, temperature }) → Promise<object>
 *
 * @param {string} systemPrompt  — Full system instruction (from *.prompt.js)
 * @param {object} input         — Structured data payload (serialised to JSON)
 * @param {number} [temperature] — 0.2 default for deterministic career outputs
 * @returns {Promise<object>}    — Parsed JSON object from the LLM
 *
 * @throws {Error} if aiRouter has no available providers
 * @throws {Error} if the LLM response cannot be parsed as JSON
 */
async function generate({ systemPrompt, input, temperature = 0.2 }) {
  if (!systemPrompt || typeof systemPrompt !== 'string') {
    throw new Error('[llmClient] systemPrompt must be a non-empty string');
  }
  if (!input || typeof input !== 'object') {
    throw new Error('[llmClient] input must be a non-null object');
  }

  // Serialise the structured input as readable JSON.
  // Indented (2 spaces) so the model can parse it reliably even at lower
  // context window sizes. Keys are kept as-is (no snake_case conversion)
  // to match the field names documented in the prompt's input contract.
  const userPayload = JSON.stringify(input, null, 2);

  // Combine into a single string. All providers in aiRouter accept one prompt
  // string — prepending the system instruction ensures every provider
  // (including those without a dedicated system role like OpenRouter + Llama)
  // receives the full context.
  const combinedPrompt = [
    systemPrompt,
    '',
    '---',
    'INPUT DATA (JSON):',
    userPayload,
    '',
    'Return ONLY valid JSON. No markdown fences, no explanation, no preamble.',
  ].join('\n');

  logger.debug('[llmClient] Dispatching to AI router', {
    promptChars: combinedPrompt.length,
    temperature,
    inputKeys:   Object.keys(input),
  });

  const rawText = await generateAIResponse(combinedPrompt, {
    temperature,
    maxTokens: 2048,
  });

  // aiRouter returns this specific string when ALL providers are exhausted
  if (!rawText || rawText === 'AI service temporarily unavailable.') {
    throw new Error(
      '[llmClient] All AI providers are currently unavailable. ' +
      'Please retry in a few minutes.'
    );
  }

  const parsed = stripAndParseJSON(rawText);

  logger.debug('[llmClient] LLM response parsed successfully', {
    topLevelKeys: Object.keys(parsed),
  });

  return parsed;
}

module.exports = { generate };








