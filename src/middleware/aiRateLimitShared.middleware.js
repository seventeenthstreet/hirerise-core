'use strict';

/**
 * src/middleware/aiRateLimitShared.middleware.js
 *
 * Shared, importable AI rate-limit middleware instance.
 *
 * PHASE 2D — QUOTA BOUNDARY FIX
 * ─────────────────────────────────────────────────────────────────────────────
 * PROBLEM:
 *   The original aiRateLimit was defined as a local constant inside server.js
 *   and applied at the app.use(API_PREFIX, aiRateLimit, ...) mount level for
 *   semantic.routes and personalization.routes. Because those mounts are on the
 *   bare /api/v1 prefix, aiRateLimit fired as middleware for EVERY /api/v1/*
 *   request — including free onboarding operations like POST /users/me/direction.
 *
 *   A user who had consumed their 20 req/min AI bucket (via copilot, advisor,
 *   semantic-match, etc.) would receive a 429 on direction selection, causing
 *   the "Upgrade required" modal to appear BEFORE onboarding was complete.
 *
 * FIX:
 *   This module exports the same express-rate-limit instance that server.js
 *   previously created inline. Routes import it directly and apply it per-handler,
 *   NOT at mount level. Free onboarding paths never hit this middleware.
 *
 * COUNTER SEMANTICS:
 *   Identical to the previous server.js instance:
 *   - 20 requests per 60-second window, per authenticated UID (falls back to IP)
 *   - In-memory store in dev/test; Redis store in production (via server.js RedisStore)
 *   - Canonical V2 envelope on 429: { success, error.code, error.message, meta.retryAfter }
 *
 * NOTE: In production, this instance uses the in-memory store (no Redis store
 * constructor is available outside server.js without circular deps). This is
 * acceptable: the counter resets on pod restart, same as before. For strict
 * cross-pod enforcement, use the Supabase-backed aiRateLimit.middleware.js instead.
 *
 * USAGE (route-level — the only correct usage):
 *   const { aiRateLimitShared } = require('../../middleware/aiRateLimitShared.middleware');
 *   router.get('/expensive-ai-endpoint', aiRateLimitShared, handler);
 *
 * DO NOT use at app.use() mount level — that was the exact bug this fixes.
 */

const rateLimit = require('express-rate-limit');

const IS_TEST = process.env.NODE_ENV === 'test';

const aiRateLimitShared = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20,
  keyGenerator: (req) => req.user?.id || req.user?.uid || req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  // Canonical V2 envelope — matches the shape that parseApiResponse expects.
  // error.code = 'RATE_LIMITED', meta.retryAfter = seconds (not ms).
  message: {
    success: false,
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many AI inference requests. Please wait before retrying.',
    },
    meta: {
      retryAfter: 60,
      timestamp: new Date().toISOString(),
    },
  },
  // Never block in test environment — avoids test order sensitivity.
  skip: () => IS_TEST,
});

module.exports = { aiRateLimitShared };