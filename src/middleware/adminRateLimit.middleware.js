'use strict';

/**
 * adminRateLimit.middleware.js — Rate Limiting for Admin & Master Admin Routes
 *
 * Uses express-rate-limit (already in package.json).
 *
 * Limits:
 *   Admin routes  (/api/v1/admin/*)  → 50 requests per minute per IP
 *   Master routes (/api/v1/master/*) → 30 requests per minute per IP
 *
 * Mount in server.js BEFORE the route groups:
 *   app.use(`${API_PREFIX}/admin`,  adminRateLimit);
 *   app.use(`${API_PREFIX}/master`, masterRateLimit);
 *
 * @module middleware/adminRateLimit.middleware
 */

const rateLimit = require('express-rate-limit');

const RATE_LIMIT_RESPONSE = (code, message) => ({
  success: false,
  error: {
    code,
    message,
  },
});

/**
 * Rate limiter for /api/v1/admin/* routes.
 * 50 requests per minute per IP.
 */
const adminRateLimit = rateLimit({
  windowMs:        60 * 1000, // 1 minute
  max:             50,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator:    (req) => req.user?.uid || req.ip,
  handler: (req, res) => {
    res.status(429).json(
      RATE_LIMIT_RESPONSE(
        'RATE_LIMIT_EXCEEDED',
        'Too many requests. Please try again later.'
      )
    );
  },
});

/**
 * Rate limiter for /api/v1/master/* routes.
 * 30 requests per minute per IP.
 */
const masterRateLimit = rateLimit({
  windowMs:        60 * 1000, // 1 minute
  max:             30,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator:    (req) => req.user?.uid || req.ip,
  handler: (req, res) => {
    res.status(429).json(
      RATE_LIMIT_RESPONSE(
        'RATE_LIMIT_EXCEEDED',
        'Too many requests. Please try again later.'
      )
    );
  },
});

module.exports = { adminRateLimit, masterRateLimit };








