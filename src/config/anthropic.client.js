'use strict';

/**
 * @file src/config/anthropic.client.js
 * @description
 * Production-grade Anthropic compatibility wrapper over AI Router.
 *
 * Optimized for:
 * - timeout-safe execution
 * - retry resilience
 * - prompt size protection
 * - stable response contract
 * - future streaming compatibility
 * - zero dynamic require hot-path cost
 */

let logger;
try {
  logger = require('../utils/logger').logger || require('../utils/logger');
} catch {
  logger = console;
}

const { generateAIResponse } = require('../services/aiRouter');

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_PROMPT_CHARS = 24000;
const MAX_RETRIES = 2;

// ─────────────────────────────────────────────────────────────────────────────
// Prompt builder
// ─────────────────────────────────────────────────────────────────────────────
function buildPrompt(params = {}) {
  const parts = [];

  if (typeof params.system === 'string' && params.system.trim()) {
    parts.push(`SYSTEM:\n${params.system.trim()}`);
  }

  const messages = Array.isArray(params.messages) ? params.messages : [];

  for (const msg of messages) {
    if (!msg) continue;

    const role = String(msg.role || 'user').toUpperCase();
    let content = '';

    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = msg.content
        .map((block) => block?.text || '')
        .join('');
    } else if (msg.content != null) {
      content = String(msg.content);
    }

    if (content.trim()) {
      parts.push(`${role}:\n${content.trim()}`);
    }
  }

  const prompt = parts.join('\n\n').trim();

  if (prompt.length > MAX_PROMPT_CHARS) {
    return prompt.slice(prompt.length - MAX_PROMPT_CHARS);
  }

  return prompt;
}

// ─────────────────────────────────────────────────────────────────────────────
// Response wrapper
// ─────────────────────────────────────────────────────────────────────────────
function wrapResponse(text) {
  return {
    id: `router-${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: 'ai-router',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Timeout-safe wrapper
// ─────────────────────────────────────────────────────────────────────────────
function withTimeout(promise, ms = DEFAULT_TIMEOUT_MS) {
  let timeoutId;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error('AI Router timeout exceeded'));
    }, ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Retry wrapper
// ─────────────────────────────────────────────────────────────────────────────
async function withRetry(fn, retries = MAX_RETRIES) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      const isLast = attempt === retries;
      if (isLast) break;

      logger.warn('[anthropic.client] Retry attempt failed', {
        attempt: attempt + 1,
        message: error.message,
      });

      await new Promise((resolve) =>
        setTimeout(resolve, 250 * (attempt + 1))
      );
    }
  }

  throw lastError;
}

// ─────────────────────────────────────────────────────────────────────────────
// Proxy client
// ─────────────────────────────────────────────────────────────────────────────
function buildClient() {
  if (process.env.NODE_ENV === 'test') {
    return null;
  }

  return {
    messages: {
      async create(params = {}) {
        if (!params.messages && !params.system) {
          throw new Error('Invalid AI request: missing messages/system');
        }

        const prompt = buildPrompt(params);

        if (!prompt) {
          throw new Error('Generated prompt is empty');
        }

        const options = {
          maxTokens: params.max_tokens ?? 2048,
          temperature: params.temperature ?? 0.3,
        };

        logger.debug('[anthropic.client] → AI Router', {
          model: params.model,
          maxTokens: options.maxTokens,
          promptLength: prompt.length,
        });

        const text = await withRetry(() =>
          withTimeout(
            generateAIResponse(prompt, options),
            DEFAULT_TIMEOUT_MS
          )
        );

        if (typeof text !== 'string' || !text.trim()) {
          throw new Error('Invalid AI response type');
        }

        if (text === 'AI service temporarily unavailable.') {
          throw new Error(
            'AI service temporarily unavailable — all providers failed.'
          );
        }

        return wrapResponse(text);
      },

      // future streaming-compatible surface
      async stream(params = {}) {
        return this.create(params);
      },
    },
  };
}

module.exports = buildClient();