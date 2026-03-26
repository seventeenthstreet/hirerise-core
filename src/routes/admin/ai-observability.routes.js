'use strict';

const express = require('express');
const router = express.Router();
const metricsService = require('../../ai/observability/metrics.service');
const driftService = require('../../ai/observability/drift.service');
const costTracker = require('../../ai/observability/cost-tracker.service');
const slaService = require('../../ai/observability/sla.service');
const circuitBreaker = require('../../ai/circuit-breaker/circuit-breaker.service');
const shadowModelService = require('../../ai/shadow/shadow-model.service');
const calibrationService = require('../../ai/observability/confidence-calibration.service');
const observabilityRepo = require('../../repositories/ai-observability.repository');

/**
 * Admin AI Observability Dashboard API — V2
 *
 * All error responses use the standard envelope:
 *   { success: false, errorCode: '...', message: '...', timestamp: '...' }
 *
 * NEW IN V2:
 *   GET  /admin/ai/sla              - SLA status per feature
 *   GET  /admin/ai/circuit-breaker  - circuit state per feature
 *   GET  /admin/ai/shadow           - shadow model comparison summary
 *   GET  /admin/ai/calibration      - confidence calibration report
 *   GET  /admin/ai/audit            - governance audit trail
 *   POST /admin/ai/feedback         - submit user feedback for calibration
 *
 * EXISTING (unchanged API, enhanced response):
 *   GET  /admin/ai/metrics
 *   GET  /admin/ai/drift
 *   GET  /admin/ai/cost
 *   GET  /admin/ai/alerts
 *   POST /admin/ai/alerts/:id/resolve
 *   POST /admin/ai/aggregate
 */

// ─── Shared error helpers ─────────────────────────────────────────────────────

/**
 * Standard error envelope — used by all error responses in this file.
 * Keeps the shape consistent with errorHandler.js across the whole API.
 */
function stdError(res, status, errorCode, message) {
  return res.status(status).json({
    success:   false,
    errorCode,
    message,
    timestamp: new Date().toISOString(),
  });
}

// ─── RBAC ─────────────────────────────────────────────────────────────────────
// Secondary admin check (primary is requireAdmin applied at server.js mount).
// This guard additionally allows customClaims.role for compatibility with
// Firebase SDKs that surface claims differently.

const requireAdminRole = (req, res, next) => {
  const role = req.user?.role || req.user?.customClaims?.role;
  if (!['admin', 'super_admin'].includes(role)) {
    return stdError(res, 403, 'FORBIDDEN', 'Admin privileges required.');
  }
  next();
};

const requireSuperAdmin = (req, res, next) => {
  const role = req.user?.role || req.user?.customClaims?.role;
  if (role !== 'super_admin') {
    return stdError(res, 403, 'FORBIDDEN', 'Super admin privileges required.');
  }
  next();
};

router.use(requireAdminRole);

// ─── EXISTING ENDPOINTS ───────────────────────────────────────────────────────

router.get('/metrics', async (req, res, next) => {
  try {
    const days    = Math.min(parseInt(req.query.days) || 7, 90);
    const feature = req.query.feature || null;
    const data    = feature
      ? { [feature]: await observabilityRepo.getDailyMetrics(feature, { limit: days }) }
      : await metricsService.getDashboardSummary({ days });
    return res.json({ success: true, data, meta: { days, generatedAt: new Date().toISOString() } });
  } catch (err) { return next(err); }
});

router.get('/drift', async (req, res, next) => {
  try {
    const days    = Math.min(parseInt(req.query.days) || 30, 90);
    const segment = req.query.segment ? JSON.parse(req.query.segment) : null;
    const data    = await driftService.getDriftReport({ feature: req.query.feature || null, days, segment });
    return res.json({ success: true, data, meta: { days, generatedAt: new Date().toISOString() } });
  } catch (err) { return next(err); }
});

router.get('/cost', async (req, res, next) => {
  try {
    const data = await costTracker.getMonthlySummary(req.query.month || null);
    return res.json({ success: true, data, meta: { generatedAt: new Date().toISOString() } });
  } catch (err) { return next(err); }
});

router.get('/alerts', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const data  = await observabilityRepo.getActiveAlerts({
      feature:  req.query.feature,
      severity: req.query.severity,
      limit,
    });
    return res.json({ success: true, data, meta: { count: data.length, generatedAt: new Date().toISOString() } });
  } catch (err) { return next(err); }
});

router.post('/alerts/:id/resolve', async (req, res, next) => {
  try {
    await observabilityRepo.resolveAlert(req.params.id, req.user.uid);
    return res.json({ success: true });
  } catch (err) { return next(err); }
});

// ─── NEW V2 ENDPOINTS ─────────────────────────────────────────────────────────

/**
 * GET /admin/ai/sla
 * SLA status per feature with breach history and uptime %.
 */
router.get('/sla', async (req, res, next) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 90);
    const data = await slaService.getSLAStatus({ days });
    return res.json({ success: true, data, meta: { days, generatedAt: new Date().toISOString() } });
  } catch (err) { return next(err); }
});

/**
 * GET /admin/ai/circuit-breaker
 * Current circuit state for all features.
 */
router.get('/circuit-breaker', async (req, res, next) => {
  try {
    const statuses      = circuitBreaker.getAllStatuses();
    const switchHistory = await observabilityRepo.getModelSwitchHistory({ limit: 20 });
    return res.json({
      success: true,
      data:    { currentStatuses: statuses, recentSwitches: switchHistory },
      meta:    { generatedAt: new Date().toISOString() },
    });
  } catch (err) { return next(err); }
});

/**
 * GET /admin/ai/shadow?feature=resume_scoring&shadowModel=claude-3-5-sonnet&days=14
 * Shadow model comparison summary and promotion recommendation.
 */
router.get('/shadow', async (req, res, next) => {
  try {
    const { feature, shadowModel } = req.query;
    if (!feature || !shadowModel) {
      return stdError(res, 400, 'VALIDATION_ERROR', 'feature and shadowModel query params are required.');
    }
    const days = Math.min(parseInt(req.query.days) || 14, 30);
    const data = await shadowModelService.getShadowSummary(feature, shadowModel, { days });
    return res.json({ success: true, data, meta: { generatedAt: new Date().toISOString() } });
  } catch (err) { return next(err); }
});

/**
 * GET /admin/ai/calibration?feature=resume_scoring&days=30
 * Confidence calibration report with ECE, Brier score, bucket analysis.
 */
router.get('/calibration', async (req, res, next) => {
  try {
    const { feature } = req.query;
    const days = Math.min(parseInt(req.query.days) || 30, 90);

    if (feature) {
      const data = await calibrationService.computeCalibration(feature, { days });
      return res.json({ success: true, data, meta: { generatedAt: new Date().toISOString() } });
    }

    const features = ['resume_scoring', 'salary_benchmark', 'skill_recommendation', 'career_path'];
    const data = {};
    for (const f of features) {
      data[f] = await calibrationService.computeCalibration(f, { days });
    }
    return res.json({ success: true, data, meta: { days, generatedAt: new Date().toISOString() } });
  } catch (err) { return next(err); }
});

/**
 * POST /admin/ai/feedback
 * Submit user feedback for calibration tracking.
 * Body: { logId, userId, feature, confidenceScore, outcome, feedbackType }
 */
router.post('/feedback', async (req, res, next) => {
  try {
    const { logId, userId, feature, confidenceScore, outcome, feedbackType } = req.body;
    if (!logId || !feature || outcome == null) {
      return stdError(res, 400, 'VALIDATION_ERROR', 'logId, feature, and outcome are required.');
    }
    await calibrationService.recordFeedback({ logId, userId, feature, confidenceScore, outcome, feedbackType });
    return res.json({ success: true });
  } catch (err) { return next(err); }
});

/**
 * GET /admin/ai/audit
 * Governance audit trail: model switches, SLA breaches, alert resolutions.
 * Super admin only.
 */
router.get('/audit', requireSuperAdmin, async (req, res, next) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 365);
    const [modelSwitches, slaBreaches, resolvedAlerts] = await Promise.all([
      observabilityRepo.getModelSwitchHistory({ limit: 100 }),
      observabilityRepo.getSLABreaches(null, days),
      observabilityRepo.getResolvedAlerts({ limit: 100 }),
    ]);

    return res.json({
      success: true,
      data: {
        modelSwitchEvents: modelSwitches,
        slaBreaches,
        resolvedAlerts,
        summary: {
          totalModelSwitches:   modelSwitches.length,
          totalSLABreaches:     slaBreaches.length,
          totalResolvedAlerts:  resolvedAlerts.length,
          auditPeriodDays:      days,
        },
      },
      meta: { generatedAt: new Date().toISOString() },
    });
  } catch (err) { return next(err); }
});

/**
 * POST /admin/ai/aggregate — super_admin only
 */
router.post('/aggregate', requireSuperAdmin, async (req, res, next) => {
  try {
    const dailyWorker = require('../../workers/daily-aggregation.worker');
    const slaWorker   = require('../../workers/sla-evaluation.worker');
    const [aggResult, slaResult] = await Promise.all([
      dailyWorker.runJob(req.body.date || null),
      slaWorker.runJob(req.body.date || null),
    ]);
    return res.json({ success: true, data: { aggregation: aggResult, sla: slaResult } });
  } catch (err) { return next(err); }
});

module.exports = router;








