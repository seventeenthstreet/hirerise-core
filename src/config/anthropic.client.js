'use strict';

/**
 * anthropic.client.js — Multi-Provider AI Router Compatibility Shim
 *
 * REFACTORED: This module no longer holds an Anthropic SDK client or reads
 * ANTHROPIC_API_KEY from the environment.
 *
 * It returns a proxy object whose public shape is identical to the Anthropic
 * SDK's `messages.create()` interface so that every existing service file
 * continues to work without any modification.
 *
 * Internally, `messages.create()` calls the AI Router which:
 *   1. Tries each provider in order (Gemini → Fireworks → Mistral →
 *      OpenRouter → Claude)
 *   2. Fetches API keys from the Secret Manager inside each provider
 *   3. Skips providers marked temporarily unhealthy (5-min cooldown)
 *   4. Enforces a per-provider 12 s timeout
 *   5. Returns the first successful plain-text response
 *
 * The object returned from `messages.create()` matches the Anthropic SDK
 * response shape so callers can use:
 *   response.content[0].text
 *   response.content.filter(b => b.type === 'text').map(b => b.text).join('')
 *   response.usage?.input_tokens
 *
 * No controllers, routes, or service files need to change.
 */

const logger = require('../utils/logger');

// ─── Prompt Builder ───────────────────────────────────────────────────────────

/**
 * Convert an Anthropic-style messages.create() payload into a single
 * flat prompt string for the provider-agnostic router.
 *
 * @param {{ system?: string, messages?: object[] }} params
 * @returns {string}
 */
function buildPrompt(params) {
  const parts = [];

  if (params.system && params.system.trim()) {
    parts.push('SYSTEM:\n' + params.system.trim());
  }

  const messages = params.messages || [];
  for (const msg of messages) {
    const role = (msg.role || 'user').toUpperCase();
    const content =
      typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.map(function (b) { return b.text || ''; }).join('')
          : String(msg.content || '');

    parts.push(role + ':\n' + content.trim());
  }

  return parts.join('\n\n');
}

// ─── Response Wrapper ─────────────────────────────────────────────────────────

/**
 * Wrap plain text in the Anthropic SDK response shape so all existing
 * `response.content[0].text` and `response.usage?.input_tokens` usages
 * continue to work without modification.
 *
 * @param {string} text
 * @returns {object}
 */
function wrapResponse(text) {
  return {
    id:            'router-' + Date.now(),
    type:          'message',
    role:          'assistant',
    model:         'ai-router',
    content:       [{ type: 'text', text: text }],
    stop_reason:   'end_turn',
    stop_sequence: null,
    usage: {
      // Token counts are not uniformly available across all providers.
      // Downstream code always guards with ?. so 0 is safe here.
      input_tokens:  0,
      output_tokens: 0,
    },
  };
}

// ─── Proxy Client ─────────────────────────────────────────────────────────────

function buildClient() {
  // Preserve existing behaviour: return null in test mode so test stubs work.
  if (process.env.NODE_ENV === 'test') {
    return null;
  }

  return {
    /**
     * Drop-in replacement for the Anthropic SDK's `messages.create(params)`.
     * Accepts the same parameters and returns a structurally identical
     * response object, backed by the multi-provider AI router.
     *
     * @param {object} params  — Same shape as Anthropic SDK messages.create()
     * @returns {Promise<object>}
     */
    messages: {
      async create(params) {
        params = params || {};

        const { generateAIResponse } = require('../services/aiRouter');
        const prompt  = buildPrompt(params);
        const options = {
          maxTokens:   params.max_tokens   != null ? params.max_tokens   : 2048,
          temperature: params.temperature  != null ? params.temperature  : 0.3,
        };

        logger.debug('[anthropic.client] Forwarding to AI Router', {
          originalModel: params.model,
          maxTokens:     options.maxTokens,
        });

        const text = await generateAIResponse(prompt, options);

        // If all providers failed the router returns this sentinel string.
        // Wrapping it as a valid response would cause every JSON.parse() caller
        // downstream to throw "Unexpected token 'A'". Throw here instead so the
        // caller's catch block handles it correctly (retry, fallback, or 502).
        if (!text || text === 'AI service temporarily unavailable.') {
          throw new Error('AI service temporarily unavailable — all providers failed.');
        }

        return wrapResponse(text);
      },
    },
  };
}

module.exports = buildClient();








