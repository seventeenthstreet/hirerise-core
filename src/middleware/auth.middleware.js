'use strict';

/**
 * auth.middleware.js — Firebase Token Verification Middleware
 * ============================================================
 * PRODUCTION HARDENED VERSION
 *
 * CHANGES FROM ORIGINAL (audit findings):
 *
 *   BUG FIX #1 — `role` claim was never mapped to req.user
 *     Original: req.user had { uid, email, emailVerified, roles, plan }
 *     Problem:  ai-observability.routes.js checks req.user?.role
 *               verifyAdmin middleware checks req.user?.role
 *               Neither worked — admins got 403 silently in production.
 *     Fix:      Added `role: decoded.role ?? null` to req.user.
 *
 *   BUG FIX #2 — `admin` custom claim was never forwarded
 *     Fix:      Added `admin: decoded.admin ?? false` to req.user.
 *               Allows both `role === 'admin'` AND `admin === true` patterns.
 *
 *   HARDENING #1 — Token revocation check already enabled (checkRevoked: true)
 *     This was already correct — kept as-is.
 *
 *   HARDENING #2 — Added correlation ID to auth warning logs
 *
 *   HARDENING #3 — Added requireAdmin as a named export
 *     This eliminates the inline requireAdminRole closures defined
 *     in ai-observability.routes.js and adminMetrics.routes.ts.
 *     One canonical implementation, no duplication.
 *
 * USAGE:
 *   const { authenticate, requireAdmin, requireRole } = require('./auth.middleware');
 *
 *   // Standard protected route:
 *   router.get('/endpoint', authenticate, handler);
 *
 *   // Admin-only route:
 *   router.get('/admin/x', authenticate, requireAdmin, handler);
 *
 *   // Super admin only:
 *   router.post('/admin/x', authenticate, requireAdmin, requireRole('super_admin'), handler);
 */

const { getAuth } = require('firebase-admin/auth');
const logger = require('../utils/logger');

const PUBLIC_PATHS = new Set([
  '/health',
  '/health/ready',
  '/health/live',
  '/api/v1/health',
]);

// ─── authenticate ──────────────────────────────────────────────────────────────

const authenticate = (req, res, next) => {
  /**
   * TEST MODE BYPASS
   * Set TEST_PLAN and TEST_ROLE env vars to simulate different user types.
   * TEST_ADMIN=true simulates an admin user.
   */
  if (process.env.NODE_ENV === 'test') {
    const isAdmin = process.env.TEST_ADMIN === 'true';
    req.user = {
      uid:           'test-user',
      email:         'test@example.com',
      emailVerified: true,
      roles:         isAdmin ? ['admin', 'user'] : ['user'],
      plan:          process.env.TEST_PLAN ?? 'free',
      role:          process.env.TEST_ROLE ?? (isAdmin ? 'admin' : null),  // ← FIX #1
      admin:         isAdmin,                                               // ← FIX #2
    };
    return next();
  }

  if (PUBLIC_PATHS.has(req.path)) return next();

  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success:   false,
      errorCode: 'UNAUTHORIZED',
      message:   'Missing Bearer token',
      timestamp: new Date().toISOString(),
    });
  }

  const token = authHeader.slice(7);

  getAuth()
    .verifyIdToken(token, true)  // checkRevoked: true — catches revoked tokens immediately
    .then((decoded) => {
      req.user = {
        uid:           decoded.uid,
        email:         decoded.email          ?? null,
        emailVerified: decoded.email_verified ?? false,
        roles:         decoded.roles          ?? [],
        plan:          decoded.plan           ?? 'free',
        role:          decoded.role           ?? null,   // ← FIX #1: was missing
        admin:         decoded.admin          ?? false,  // ← FIX #2: was missing
        // planAmount kept for logUsageToFirestore revenue attribution
        planAmount:    decoded.planAmount     ?? null,
      };
      next();
    })
    .catch((err) => {
      logger.warn('[Auth] Token verification failed', {
        ip:            req.ip,
        path:          req.path,
        correlationId: req.headers['x-correlation-id'],
        errorCode:     err.code,
      });

      const isExpired = err.code === 'auth/id-token-expired';
      const isRevoked = err.code === 'auth/id-token-revoked';

      return res.status(401).json({
        success:   false,
        errorCode: 'UNAUTHORIZED',
        message:   isExpired
          ? 'Token expired. Please refresh and retry.'
          : isRevoked
            ? 'Token has been revoked. Please sign in again.'
            : 'Invalid token.',
        timestamp: new Date().toISOString(),
      });
    });
};

// ─── requireEmailVerified ─────────────────────────────────────────────────────

const requireEmailVerified = (req, res, next) => {
  if (!req.user?.emailVerified) {
    return res.status(403).json({
      success:   false,
      errorCode: 'FORBIDDEN',
      message:   'Email verification required.',
      timestamp: new Date().toISOString(),
    });
  }
  next();
};

// ─── requireAdmin ─────────────────────────────────────────────────────────────
/**
 * Canonical admin guard — replaces the inline `requireAdminRole` closures
 * defined separately in ai-observability.routes.js and adminMetrics.routes.ts.
 *
 * Accepts EITHER pattern:
 *   - decoded.admin === true  (new recommended pattern)
 *   - decoded.role === 'admin' | 'super_admin' (existing codebase pattern)
 *   - decoded.roles includes 'admin'
 *
 * To grant admin access to a user (run once from admin script):
 *   await getAuth().setCustomUserClaims(uid, { admin: true, role: 'admin' });
 */
const requireAdmin = (req, res, next) => {
  const user = req.user;

  if (!user) {
    return res.status(401).json({
      success: false, errorCode: 'UNAUTHORIZED', message: 'Authentication required.',
      timestamp: new Date().toISOString(),
    });
  }

  const isAdmin =
    user.admin === true ||
    ['admin', 'super_admin'].includes(user.role ?? '') ||
    (user.roles ?? []).includes('admin');

  if (!isAdmin) {
    logger.warn('[Auth] Unauthorized admin access attempt', {
      uid:  user.uid,
      path: req.originalUrl,
    });
    return res.status(403).json({
      success:   false,
      errorCode: 'FORBIDDEN',
      message:   'Admin privileges required.',
      timestamp: new Date().toISOString(),
    });
  }

  next();
};

// ─── requireRole ──────────────────────────────────────────────────────────────
/**
 * Checks for a specific role string.
 * Use for super_admin-only endpoints:
 *   router.post('/aggregate', authenticate, requireAdmin, requireRole('super_admin'), handler)
 */
const requireRole = (role) => {
  return (req, res, next) => {
    const userRole  = req.user?.role;
    const userRoles = req.user?.roles ?? [];

    if (userRole !== role && !userRoles.includes(role)) {
      return res.status(403).json({
        success:   false,
        errorCode: 'FORBIDDEN',
        message:   `Role '${role}' required.`,
        timestamp: new Date().toISOString(),
      });
    }
    next();
  };
};

module.exports = { authenticate, requireEmailVerified, requireAdmin, requireRole };