/**
 * verifyAdmin.middleware.ts
 *
 * Two-layer admin guard for all /admin/metrics routes:
 *
 *   Layer 1 — Firebase token verification (already done by authenticate)
 *   Layer 2 — Admin claim check (this middleware)
 *
 * IMPORTANT: This middleware MUST be placed AFTER the authenticate middleware
 * in the route chain, as it depends on req.user being populated.
 *
 * How to set admin claims (run once per admin user):
 *   const { getAuth } = require('firebase-admin/auth');
 *   await getAuth().setCustomUserClaims(uid, { admin: true, role: 'admin' });
 *
 * ARCHITECTURE NOTE:
 *   Admin claim is stored in Firebase token as `decodedToken.admin === true`
 *   OR `decodedToken.role === 'admin' | 'super_admin'`.
 *   We check both patterns for compatibility with the existing codebase
 *   which uses `role` in ai-observability.routes.js.
 *
 * NOTE: If your project uses CommonJS (server.js uses require/module.exports),
 *   use requireAdmin and requireRole from auth.middleware.js instead.
 *   This file is for TypeScript ESM contexts only (e.g. adminMetrics.routes.ts).
 *
 * Usage:
 *   router.get('/metrics', authenticate, verifyAdmin, metricsController);
 */

// ← FIX 1: Removed 'use strict' — incompatible with ES module import syntax
import { Request, Response, NextFunction } from 'express';

// ─── AdminRequest ─────────────────────────────────────────────────────────────

export interface AdminRequest extends Request {
  user?: {
    uid:           string;
    email:         string | null;
    emailVerified: boolean;
    roles:         string[];
    plan:          string;
    admin?:        boolean;  // Firebase custom claim: admin === true
    role?:         string;   // Firebase custom claim: 'admin' | 'super_admin'
    planAmount?:   number | null;
  };
}

// ─── verifyAdmin ──────────────────────────────────────────────────────────────

/**
 * verifyAdmin
 *
 * Checks that the authenticated user has admin privileges.
 * Rejects non-admins with 403 before any business logic executes.
 *
 * Accepts ANY of these three patterns (covers old + new claims):
 *   - decoded.admin === true
 *   - decoded.role === 'admin' | 'super_admin'
 *   - decoded.roles includes 'admin'
 */
export function verifyAdmin(
  req:  AdminRequest,
  res:  Response,
  next: NextFunction,
): void {
  const user = req.user;

  if (!user) {
    res.status(401).json({
      success:   false,
      errorCode: 'UNAUTHORIZED',
      message:   'Authentication required.',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // FIX 3: No more (user as any) casts — role and admin are typed on AdminRequest
  const isAdmin =
    user.admin === true ||
    ['admin', 'super_admin'].includes(user.role ?? '') ||
    (user.roles ?? []).includes('admin');

  if (!isAdmin) {
    res.status(403).json({
      success:   false,
      errorCode: 'FORBIDDEN',
      message:   'Admin privileges required.',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  next();
}

// ─── verifySuperAdmin ─────────────────────────────────────────────────────────

/**
 * verifySuperAdmin
 *
 * Stricter guard for destructive admin operations (e.g., manual aggregation).
 * Only allows role === 'super_admin'.
 */
export function verifySuperAdmin(
  req:  AdminRequest,
  res:  Response,
  next: NextFunction,
): void {
  const user = req.user;

  // FIX 3: No more (user as any) cast — role is typed on AdminRequest
  if (!user || user.role !== 'super_admin') {
    res.status(403).json({
      success:   false,
      errorCode: 'FORBIDDEN',
      message:   'Super admin privileges required.',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  next();
}