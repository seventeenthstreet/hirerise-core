'use strict';

/**
 * requireTier.middleware.js — Supabase Version (Production Optimized)
 */

const crypto = require('crypto');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const KNOWN_TIERS = new Set([
  'free',
  'pro',
  'elite',
  'enterprise',
]);

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function getRequestId(req) {
  return (
    req.correlationId || // ✅ align with global tracing
    req.headers['x-correlation-id'] ||
    req.headers['x-request-id'] ||
    crypto.randomUUID()
  );
}

function normalizeTier(raw) {
  if (!raw || typeof raw !== 'string') return 'free';

  const lower = raw.toLowerCase().trim();

  // legacy alias support
  if (lower === 'premium') return 'pro';

  return KNOWN_TIERS.has(lower) ? lower : 'free';
}

function normalizeAllowedTiers(allowedTiers) {
  if (!Array.isArray(allowedTiers)) return [];

  return allowedTiers
    .filter(t => typeof t === 'string')
    .map(t => normalizeTier(t));
}

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE FACTORY
// ─────────────────────────────────────────────────────────────────────────────

function requireTier(allowedTiers) {
  const normalizedAllowed = normalizeAllowedTiers(allowedTiers);

  if (normalizedAllowed.length === 0) {
    throw new Error('[requireTier] allowedTiers must be a non-empty array of valid tier strings');
  }

  const allowedSet = new Set(normalizedAllowed);

  return function requireTierMiddleware(req, res, next) {
    const requestId = getRequestId(req);

    // ── Auth check ─────────────────────────────────────────
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required.',
        },
        requestId,
        timestamp: new Date().toISOString(),
      });
    }

    const userId = req.user.id;
    const tier = normalizeTier(req.user.plan);

    // Attach normalized tier for downstream usage
    req.user.normalizedTier = tier;

    // ── Access check ───────────────────────────────────────
    if (!allowedSet.has(tier)) {
      logger.warn('[RequireTier] Access denied', {
        requestId,
        correlationId: req.correlationId, // ✅ observability
        userId,
        tier,
        allowedTiers: normalizedAllowed,
        path: req.originalUrl,
        method: req.method,
        ip: req.ip,
      });

      return res.status(403).json({
        success: false,
        error: {
          code: 'TIER_INSUFFICIENT',
          message: `This feature is not available on your current plan (${tier}). Please upgrade to continue.`,
        },
        details: {
          currentTier: tier,
          requiredTiers: normalizedAllowed,
        },
        requestId,
        timestamp: new Date().toISOString(),
      });
    }

    return next();
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  requireTier,
  normalizeTier,
};