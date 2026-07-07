'use strict';

/**
 * src/routes/admin/xaiMetrics.routes.js  [WP-13B PATCH]
 *
 * Replaces Phase 1 (WP-7) zero-value stubs with live aggregation.
 *
 * Mounts at: /api/v1/metrics
 *
 *   GET /api/v1/metrics/xai-usage   → xaiMetricsService.getUsageMetrics(req.query)
 *   GET /api/v1/metrics/xai-tier    → xaiMetricsService.getTierDistribution(req.query)
 *
 * FILTER PARAMS (forwarded to service):
 *   date_from?  string  (ISO-8601)
 *   date_to?    string  (ISO-8601)
 *   grain?      'daily' | 'weekly' | 'monthly'   (accepted, not yet used in aggregation)
 *   user_type?  string                             (accepted, not yet used)
 *   variant?    string                             (accepted, not yet used)
 *
 * SECURITY:
 *   Admin role required on both endpoints (unchanged from WP-7).
 *   No user data in responses — aggregate counts and rates only.
 *
 * FRONTEND COMPATIBILITY:
 *   Response shapes are identical to the WP-7 stubs.
 *   useXaiMetrics() and useXaiDashboard() require ZERO changes.
 */

const express = require('express');
const router  = express.Router();

const xaiMetricsService = require('../../services/xaiMetrics.service');

// ─── RBAC ─────────────────────────────────────────────────────────────────────

const requireAdminRole = (req, res, next) => {
  const role = req.user?.role || req.user?.customClaims?.role;
  if (!['admin', 'super_admin'].includes(role)) {
    return res.status(403).json({ error: 'Forbidden', code: 'ADMIN_REQUIRED' });
  }
  next();
};

router.use(requireAdminRole);

// ─── GET /api/v1/metrics/xai-usage ───────────────────────────────────────────

router.get('/xai-usage', async (req, res) => {
  try {
    const filters = {
      date_from: req.query.date_from,
      date_to:   req.query.date_to,
    };
    const metrics = await xaiMetricsService.getUsageMetrics(filters);
    return res.status(200).json(metrics);
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to fetch XAI usage metrics' });
  }
});

// ─── GET /api/v1/metrics/xai-tier ────────────────────────────────────────────

router.get('/xai-tier', async (req, res) => {
  try {
    const filters = {
      date_from: req.query.date_from,
      date_to:   req.query.date_to,
    };
    const metrics = await xaiMetricsService.getTierDistribution(filters);
    return res.status(200).json(metrics);
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to fetch XAI tier metrics' });
  }
});

module.exports = router;
