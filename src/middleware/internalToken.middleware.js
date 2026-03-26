'use strict';

/**
 * internalToken.middleware.js
 *
 * Guards internal service-to-service endpoints (e.g. Cloud Tasks callbacks).
 * These endpoints are NOT protected by auth token because the caller is
 * Google Cloud Tasks (a server), not a user.
 *
 * HOW IT WORKS:
 *   - Checks Authorization: Bearer <token> matches INTERNAL_SERVICE_TOKEN env var
 *   - Returns 401 if token is missing or mismatched
 *   - Returns 503 if INTERNAL_SERVICE_TOKEN is not configured (misconfiguration guard)
 *
 * SETUP:
 *   1. Generate a strong random secret:
 *        node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *   2. Set in Cloud Run:
 *        INTERNAL_SERVICE_TOKEN=<generated-secret>
 *   3. Set the same value in the Cloud Tasks task header (already done in
 *      triggerProvisionalChi in onboarding.helpers.js).
 *
 * USAGE:
 *   const { requireInternalToken } = require('../middleware/internalToken.middleware');
 *   router.post('/internal/provisional-chi', requireInternalToken, handler);
 *
 * SECURITY NOTE:
 *   - This route should never be exposed to the public internet.
 *     In Cloud Run, it is called only from Cloud Tasks which uses the same VPC.
 *   - The token is compared using timingSafeEqual to prevent timing attacks.
 */

const crypto = require('crypto');
const logger = require('../utils/logger');

function requireInternalToken(req, res, next) {
  const configuredToken = process.env.INTERNAL_SERVICE_TOKEN;

  // Misconfiguration guard — fail loudly at request time, not silently
  if (!configuredToken) {
    logger.error('[InternalToken] INTERNAL_SERVICE_TOKEN is not set — internal endpoint is unprotected', {
      path: req.path,
    });
    return res.status(503).json({
      success:   false,
      errorCode: 'SERVICE_MISCONFIGURED',
      message:   'Internal service token not configured.',
      timestamp: new Date().toISOString(),
    });
  }

  const authHeader = req.headers.authorization || '';
  const incoming   = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (!incoming) {
    logger.warn('[InternalToken] Missing Authorization header on internal endpoint', { path: req.path });
    return res.status(401).json({
      success:   false,
      errorCode: 'UNAUTHORIZED',
      message:   'Internal service token required.',
      timestamp: new Date().toISOString(),
    });
  }

  // Constant-time comparison — prevents timing attacks
  let valid = false;
  try {
    const a = Buffer.from(incoming,        'utf8');
    const b = Buffer.from(configuredToken, 'utf8');
    valid = a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    valid = false;
  }

  if (!valid) {
    logger.warn('[InternalToken] Invalid internal service token', {
      path: req.path,
      ip:   req.ip,
    });
    return res.status(401).json({
      success:   false,
      errorCode: 'UNAUTHORIZED',
      message:   'Invalid internal service token.',
      timestamp: new Date().toISOString(),
    });
  }

  return next();
}

module.exports = { requireInternalToken };








