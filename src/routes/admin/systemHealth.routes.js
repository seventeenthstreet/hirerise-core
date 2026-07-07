'use strict';

/**
 * systemHealth.routes.js — WP-7
 *
 * Mounts at: /api/v1/system
 *
 *   GET /api/v1/system/health
 *     Returns a lightweight system health snapshot.
 *     Phase 1: static/derived values. No external probes.
 *     WP-13: replace getSystemHealthStatus() body with real checks.
 *
 * SECURITY:
 *   Admin role required (requireAdminRole — same pattern as ai-observability.routes.js).
 *   No credentials in response. No user data in response.
 */

const express = require('express');
const router  = express.Router();

const { getSystemHealthStatus } = require('../../services/admin/systemHealth.service');

// ─── RBAC ─────────────────────────────────────────────────────────────────────
// Copied verbatim from src/routes/admin/ai-observability.routes.js.

const requireAdminRole = (req, res, next) => {
  const role = req.user?.role || req.user?.customClaims?.role;
  if (!['admin', 'super_admin'].includes(role)) {
    return res.status(403).json({ error: 'Forbidden', code: 'ADMIN_REQUIRED' });
  }
  next();
};

router.use(requireAdminRole);

// ─── GET /api/v1/system/health ────────────────────────────────────────────────

router.get('/health', async (req, res) => {
  try {
    const health = await getSystemHealthStatus();
    return res.status(200).json(health);
  } catch (err) {
    // If the health check itself throws, report degraded rather than 500.
    return res.status(200).json({
      status:         'degraded',
      environment:    process.env.NODE_ENV || 'unknown',
      build_version:  process.env.BUILD_VERSION || 'unknown',
      error_rate_24h: 0,
      checked_at:     new Date().toISOString(),
    });
  }
});

module.exports = router;