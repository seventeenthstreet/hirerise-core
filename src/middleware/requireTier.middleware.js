'use strict';

/**
 * requireTier.middleware.js
 *
 * Centralized tier enforcement middleware.
 *
 * SECURITY RULE:
 *   Tier is read ONLY from req.user.plan, which comes from the
 *   Firebase ID token custom claim (set by Admin SDK on payment).
 *   This middleware NEVER reads Firestore to determine tier.
 *
 * USAGE:
 *   const { requireTier } = require('../../middleware/requireTier.middleware');
 *
 *   router.post('/analyze', authenticate, requireTier(['pro', 'elite']), handler);
 *   router.post('/basic',   authenticate, requireTier(['free', 'pro', 'elite']), handler);
 *
 * Must be placed after authenticate middleware.
 * authenticate sets req.user.plan from the decoded Firebase token.
 */

const logger = require('../utils/logger');

// Known paid tiers — anything not in this set is treated as 'free'
const KNOWN_TIERS = new Set(['free', 'pro', 'elite', 'enterprise', 'premium']);

/**
 * Normalise raw plan value to a canonical tier string.
 * Falls back to 'free' for any unknown or missing value.
 *
 * @param {*} raw - raw value from req.user.plan
 * @returns {string}
 */
function normalizeTier(raw) {
  if (!raw || typeof raw !== 'string') return 'free';
  const lower = raw.toLowerCase().trim();
  // 'premium' is a legacy alias for 'pro' in older tokens
  if (lower === 'premium') return 'pro';
  return KNOWN_TIERS.has(lower) ? lower : 'free';
}

/**
 * requireTier(allowedTiers)
 *
 * Returns Express middleware that enforces tier access.
 *
 * @param {string[]} allowedTiers  - tiers permitted to reach this route
 * @returns {Function}             - Express middleware (req, res, next)
 */
function requireTier(allowedTiers) {
  if (!Array.isArray(allowedTiers) || allowedTiers.length === 0) {
    throw new Error('[requireTier] allowedTiers must be a non-empty array of strings');
  }

  const allowed = new Set(allowedTiers.map(t => t.toLowerCase().trim()));

  return function requireTierMiddleware(req, res, next) {
    if (!req.user) {
      return res.status(401).json({
        success:   false,
        errorCode: 'UNAUTHORIZED',
        message:   'Authentication required.',
        timestamp: new Date().toISOString(),
      });
    }

    const tier = normalizeTier(req.user.plan);

    // Attach for downstream use (services, logging) — avoids repeat normalization
    req.user.normalizedTier = tier;

    if (!allowed.has(tier)) {
      logger.warn('[RequireTier] Access denied', {
        uid:           req.user.uid,
        tier,
        allowedTiers,
        path:          req.originalUrl,
      });

      return res.status(403).json({
        success:   false,
        errorCode: 'TIER_INSUFFICIENT',
        message:   `This feature is not available on your current plan (${tier}). Please upgrade to continue.`,
        details: {
          currentTier:   tier,
          requiredTiers: allowedTiers,
        },
        timestamp: new Date().toISOString(),
      });
    }

    return next();
  };
}

module.exports = { requireTier, normalizeTier };