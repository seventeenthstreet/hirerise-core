'use strict';

/**
 * src/utils/withAITimeout.js
 * HireRise PR 2 — reusable timeout utilities
 */

const env = require('../config/env');

const AI_TIMEOUT_MS = env.AI_PROVIDER_TIMEOUT_MS;
const SUPABASE_TIMEOUT_MS =
  env.SUPABASE_TIMEOUT_MS || 8000;

/**
 * Wraps an AI provider call with AbortController timeout.
 *
 * Usage:
 *   const result = await withAITimeout(
 *     (signal) => anthropic.messages.create({ ...params, signal }),
 *     'anthropic-cv-analysis'
 *   );
 */
async function withAITimeout(
  fn,
  label = 'ai_call',
  timeoutMs = AI_TIMEOUT_MS
) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  if (timer.unref) timer.unref();

  try {
    return await fn(controller.signal);
  } catch (err) {
    if (
      controller.signal.aborted ||
      err.name === 'AbortError'
    ) {
      const error = new Error(
        `AI provider timeout after ${timeoutMs}ms [${label}]`
      );
      error.code = 'AI_TIMEOUT';
      error.retryable = true;
      error.statusCode = 503;
      throw error;
    }

    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wraps a Supabase RPC / query with Promise.race timeout.
 *
 * Usage:
 *   const result = await withSupabaseTimeout(
 *     () => supabase.rpc('expensive_function'),
 *     'expensive_function'
 *   );
 */
async function withSupabaseTimeout(
  fn,
  label = 'rpc',
  timeoutMs = SUPABASE_TIMEOUT_MS
) {
  let timer;

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(
        `Supabase timeout after ${timeoutMs}ms [${label}]`
      );
      error.code = 'SUPABASE_TIMEOUT';
      error.retryable = true;
      error.statusCode = 503;
      reject(error);
    }, timeoutMs);

    if (timer.unref) timer.unref();
  });

  try {
    return await Promise.race([
      fn(),
      timeoutPromise,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  withAITimeout,
  withSupabaseTimeout,
};