'use strict';

/**
 * src/middleware/requestTimeout.middleware.js
 * HireRise PR 2 — Backend Infra Safety
 */

const env = require('../config/env');

const TIMEOUT_MS = env.API_TIMEOUT_MS;
const AI_TIMEOUT_MS = env.AI_PROVIDER_TIMEOUT_MS;

// Paths that must never be timed out
const EXCLUDED = new Set([
  '/api/v1/health',
  '/api/v1/ready',
]);

function requestTimeout(req, res, next) {
  if (EXCLUDED.has(req.path)) return next();

  let fired = false;

  const timer = setTimeout(() => {
    fired = true;

    if (res.headersSent) return;

    res.status(503).json({
      success: false,
      error: {
        code: 'REQUEST_TIMEOUT',
        message:
          'The server did not respond in time. Please retry.',
        retryable: true,
        timeout_ms: TIMEOUT_MS,
      },
    });
  }, TIMEOUT_MS);

  if (timer.unref) timer.unref();

  const cleanup = () => clearTimeout(timer);
  res.on('finish', cleanup);
  res.on('close', cleanup);

  req.timedOut = () => fired;

  next();
}

/**
 * AI provider timeout wrapper
 */
async function withAITimeout(fn) {
  return Promise.race([
    fn(),
    new Promise((_, reject) => {
      const timer = setTimeout(() => {
        const err = new Error(
          `AI provider timeout after ${AI_TIMEOUT_MS}ms`
        );
        err.code = 'AI_TIMEOUT';
        err.retryable = true;
        reject(err);
      }, AI_TIMEOUT_MS);

      if (timer.unref) timer.unref();
    }),
  ]);
}

/**
 * Supabase RPC timeout wrapper
 */
async function withSupabaseTimeout(fn, ms = 8000) {
  return Promise.race([
    fn(),
    new Promise((_, reject) => {
      const timer = setTimeout(() => {
        const err = new Error(
          `Supabase timeout after ${ms}ms`
        );
        err.code = 'SUPABASE_TIMEOUT';
        err.retryable = true;
        reject(err);
      }, ms);

      if (timer.unref) timer.unref();
    }),
  ]);
}

module.exports = {
  requestTimeout,
  withAITimeout,
  withSupabaseTimeout,
};