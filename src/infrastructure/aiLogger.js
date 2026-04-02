'use strict';

/**
 * AI Interaction Logger (Production Optimized)
 */

const crypto = require('crypto');
const logger = require('../utils/logger');
const { supabase } = require('../config/supabase');

// ─────────────────────────────────────────────
// 🔹 CONFIG
// ─────────────────────────────────────────────

const MAX_PAYLOAD_SIZE = 10000;
const LOG_TIMEOUT = 800; // ms (reduced for speed)

// ─────────────────────────────────────────────
// 🔹 UTILS
// ─────────────────────────────────────────────

function sanitizePayload(payload = {}) {
  if (!payload || typeof payload !== 'object') return payload;

  const clone = { ...payload };

  if (clone.resume_text) clone.resume_text = '[REDACTED]';
  if (clone.personal_info) clone.personal_info = '[REDACTED]';

  return clone;
}

function generateLogId() {
  return crypto.randomBytes(8).toString('hex');
}

function isTooLarge(obj) {
  try {
    return JSON.stringify(obj).length > MAX_PAYLOAD_SIZE;
  } catch {
    return true;
  }
}

// Fire-and-forget safe insert
function insertLog(payload) {
  return supabase.from('ai_usage_logs').insert(payload);
}

// ─────────────────────────────────────────────
// 🔹 MAIN LOGGER
// ─────────────────────────────────────────────

async function logAIInteraction({
  module = 'unknown',
  model = 'unknown',
  prompt = {},
  response = {},
  usage = {},
  latencyMs = 0,
  status = 'success',
  error = null,
  userId = null
} = {}) {
  const logId = generateLogId();
  const ENV = process.env.NODE_ENV || 'development';

  try {
    // 🔹 Optimize payload handling
    const safePrompt =
      ENV === 'production'
        ? '[REDACTED]'
        : isTooLarge(prompt)
        ? '[TRUNCATED]'
        : sanitizePayload(prompt);

    const safeResponse = isTooLarge(response)
      ? '[TRUNCATED]'
      : sanitizePayload(response);

    const payload = {
      log_id: logId,
      user_id: userId ?? null,
      module,
      feature: module,
      model,
      status,
      success: status === 'success',
      latency_ms: latencyMs,

      usage: {
        prompt_tokens: usage.prompt_tokens ?? null,
        completion_tokens: usage.completion_tokens ?? null,
        total_tokens: usage.total_tokens ?? null
      },

      prompt: safePrompt,
      response: safeResponse,
      error: error ? error.message ?? String(error) : null,

      created_at: new Date().toISOString()
    };

    // 🔥 NON-BLOCKING LOGGING (IMPORTANT)
    Promise.race([
      insertLog(payload),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), LOG_TIMEOUT)
      )
    ]).catch((err) => {
      logger.warn('[aiLogger] Async logging failed', {
        logId,
        error: err.message
      });
    });

    return logId;
  } catch (err) {
    logger.warn('[aiLogger] Unexpected failure', {
      error: err.message
    });
    return null;
  }
}

module.exports = {
  logAIInteraction
};