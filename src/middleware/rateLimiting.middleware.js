'use strict';

/**
 * rateLimiting.middleware.js — HireRise Production Rate Limiting
 *
 * Architecture:
 *   - Redis-backed via ioredis (preferred in production)
 *   - Graceful fallback to in-memory (express-rate-limit) if Redis is unavailable
 *   - IP + authenticated user-ID aware (authenticated users get their own bucket)
 *   - Separate limit zones per route sensitivity
 *
 * Zones:
 *   globalLimiter     — all routes:              400 req / 15 min / IP
 *   authLimiter       — login/register/callback:  10 req / 15 min / IP (brute-force)
 *   onboardingLimiter — onboarding writes:        30 req / 15 min / user
 *   aiLimiter         — AI inference routes:      20 req / 1 min  / user
 *   appEntryLimiter   — /app-entry:               60 req / 1 min  / user
 *   usersMeLimiter    — /users/me:                120 req / 1 min / user
 */

const { rateLimit } = require('express-rate-limit');

// ── Redis store adapter ───────────────────────────────────────────────────────
let RedisStore;
try {
  // rate-limit-redis is the official adapter
  RedisStore = require('rate-limit-redis').RedisStore;
} catch {
  // If not installed, fall back to in-memory
  RedisStore = null;
}

function buildStore(redisClient, prefix) {
  if (!RedisStore || !redisClient) return undefined; // use default memory store
  return new RedisStore({
    sendCommand: (...args) => redisClient.call(...args),
    prefix: `rl:${prefix}:`,
  });
}

// ── Key extractor — prefer authenticated user ID over IP ──────────────────────
function keyByUser(req) {
  return req.user?.id ? `uid:${req.user.id}` : `ip:${req.ip}`;
}

// ── Skip internal service calls ───────────────────────────────────────────────
function skipInternal(req) {
  return req.path.startsWith('/api/v1/internal/') || !!req.internalToken;
}

// ── Standard rate limit response ──────────────────────────────────────────────
function limitHandler(req, res) {
  res.status(429).json({
    success: false,
    error: 'Too many requests. Please wait before trying again.',
    retryAfter: Math.ceil(res.getHeader('Retry-After') || 60),
    correlationId: req.correlationId,
  });
}

// ── Factory ───────────────────────────────────────────────────────────────────
function createLimiters(redisClient) {
  const opts = (prefix, windowMs, max, keyFn = (req) => req.ip) => ({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: keyFn,
    handler: limitHandler,
    skip: skipInternal,
    store: buildStore(redisClient, prefix),
  });

  return {
    // Global catch-all (400 req / 15 min per IP)
    globalLimiter: rateLimit(opts('global', 15 * 60 * 1000, 400)),

    // Auth endpoints — tight (brute-force protection)
    // 10 req / 15 min per IP, burst: Nginx handles additional burst
    authLimiter: rateLimit(opts('auth', 15 * 60 * 1000, 10)),

    // Onboarding writes — per authenticated user
    onboardingLimiter: rateLimit(opts('onboarding', 15 * 60 * 1000, 30, keyByUser)),

    // AI inference — 20 req / min per user (expensive, DDoS-sensitive)
    aiLimiter: rateLimit(opts('ai', 60 * 1000, 20, keyByUser)),

    // /app-entry — frequent polling, but still bounded
    appEntryLimiter: rateLimit(opts('app-entry', 60 * 1000, 60, keyByUser)),

    // /users/me — used for hydration; high frequency but cheap
    usersMeLimiter: rateLimit(opts('users-me', 60 * 1000, 120, keyByUser)),

    // Resume upload — slow operation, prevent abuse
    resumeUploadLimiter: rateLimit(opts('resume-upload', 60 * 60 * 1000, 10, keyByUser)),

    // Admin endpoints — internal, but still bounded per user
    adminLimiter: rateLimit(opts('admin', 60 * 1000, 60, keyByUser)),

    // Webhook endpoints — per IP, moderate
    webhookLimiter: rateLimit(opts('webhook', 60 * 1000, 30)),
  };
}

module.exports = { createLimiters };

/* ── Usage in server.js ────────────────────────────────────────────────────────
 *
 * const redis = require('./shared/redis.client'); // your existing redis singleton
 * const { createLimiters } = require('./middleware/rateLimiting.middleware');
 * const limiters = createLimiters(redis);
 *
 * // Global
 * app.use(limiters.globalLimiter);
 *
 * // Auth routes
 * app.use('/api/v1/auth', limiters.authLimiter, authRouter);
 *
 * // AI routes
 * app.use('/api/v1/career-copilot', authenticate, limiters.aiLimiter, copilotRouter);
 * app.use('/api/v1/career-advisor', authenticate, limiters.aiLimiter, advisorRouter);
 *
 * // Onboarding
 * app.use('/api/v1/onboarding', authenticate, limiters.onboardingLimiter, onboardingRouter);
 *
 * // Users/me
 * app.use('/api/v1/users/me', authenticate, limiters.usersMeLimiter, usersRouter);
 *
 * // App-entry
 * app.use('/api/v1/app-entry', authenticate, limiters.appEntryLimiter, appEntryRouter);
 *
 * ---------------------------------------------------------------------------*/
