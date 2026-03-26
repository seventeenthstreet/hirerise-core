/**
 * aiLogger.js
 * --------------------------------------------------------
 * AI Interaction Logger — Firestore-backed
 * --------------------------------------------------------
 * Writes to ai_usage_logs/{autoId} in Firestore.
 * Never writes to local filesystem (not durable on Cloud Run).
 *
 * Responsibilities:
 *  - Log AI request/response metadata
 *  - Track latency
 *  - Mask PII before storing
 *  - Fail safely — NEVER crash main flow
 * --------------------------------------------------------
 */

'use strict';

const crypto = require('crypto');
const logger = require('../utils/logger');

/**
 * Mask potentially sensitive fields before storing.
 * Returns a shallow clone with PII fields redacted.
 */
function sanitizePayload(payload = {}) {
  const clone = { ...payload };
  if (clone.resume_text)   clone.resume_text   = '[REDACTED]';
  if (clone.personal_info) clone.personal_info = '[REDACTED]';
  return clone;
}

/**
 * Generate a short unique log ID (for correlation in external logs).
 */
function generateLogId() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * logAIInteraction(params)
 *
 * Fire-and-forget. Never awaited by callers.
 * All errors are caught and swallowed silently.
 *
 * @param {object} params
 * @param {string} [params.module]     - feature/module name
 * @param {string} [params.model]      - model string
 * @param {object} [params.prompt]     - prompt payload (PII will be redacted)
 * @param {object} [params.response]   - response payload (PII will be redacted)
 * @param {object} [params.usage]      - token usage { prompt_tokens, completion_tokens, total_tokens }
 * @param {number} [params.latencyMs]
 * @param {string} [params.status]     - 'success' | 'error'
 * @param {Error|string|null} [params.error]
 * @param {string} [params.userId]     - optional userId for correlation
 * @returns {Promise<string|null>}     - logId, or null if logging failed
 */
async function logAIInteraction({
  module    = 'unknown',
  model     = 'unknown',
  prompt    = {},
  response  = {},
  usage     = {},
  latencyMs = 0,
  status    = 'success',
  error     = null,
  userId    = null,
} = {}) {
  try {
    const logId    = generateLogId();
    const ENV      = process.env.NODE_ENV || 'development';

    // Lazy-require Firestore to avoid import-time failures in test mode
    const { db, FieldValue } = require('../config/supabase');

    await db.collection('ai_usage_logs').add({
      logId,
      user_id:     userId   ?? null,
      module,
      model,
      status,
      latencyMs,
      usage: {
        promptTokens:     usage.prompt_tokens      ?? null,
        completionTokens: usage.completion_tokens  ?? null,
        totalTokens:      usage.total_tokens       ?? null,
      },
      // Redact PII; in production also hide full prompt text
      prompt:   ENV === 'production' ? '[REDACTED]' : sanitizePayload(prompt),
      response: sanitizePayload(response),
      error:    error ? (error.message ?? String(error)) : null,
      feature:  module,  // alias for aiUsage.service compatibility
      success:  status === 'success',
      createdAt: FieldValue.serverTimestamp(),
    });

    return logId;
  } catch (loggingError) {
    // Fail silently — never break main scoring flow
    logger.error('[aiLogger] Firestore write failed', { error: loggingError.message });
    return null;
  }
}

module.exports = { logAIInteraction };









