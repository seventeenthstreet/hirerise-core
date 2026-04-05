'use strict';

/**
 * src/routes/admin/adminAiObservability.routes.js
 *
 * Admin AI Observability Dashboard API — Production Ready
 * Fully Supabase-native RBAC + hardened query handling
 */

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

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function stdError(res, status, errorCode, message) {
  return res.status(status).json({
    success: false,
    errorCode,
    message,
    timestamp: new Date().toISOString(),
  });
}

function getActorId(req) {
  return req.user?.id ?? req.user?.uid ?? null;
}

function getRoleSet(req) {
  const directRole = req.user?.role;
  const metadataRole = req.user?.app_metadata?.role;
  const roles = Array.isArray(req.user?.roles) ? req.user.roles : [];

  return new Set(
    [directRole, metadataRole, ...roles].filter(Boolean)
  );
}

function hasAdminRole(req) {
  const roles = getRoleSet(req);
  return roles.has('admin') || roles.has('super_admin') || roles.has('MASTER_ADMIN');
}

function hasSuperAdminRole(req) {
  const roles = getRoleSet(req);
  return roles.has('super_admin') || roles.has('MASTER_ADMIN');
}

function safeDays(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function safeParseJson(value) {
  if (!value) return null;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// RBAC middleware
// ─────────────────────────────────────────────
const requireAdminRole = (req, res, next) => {
  if (!hasAdminRole(req)) {
    return stdError(res, 403, 'FORBIDDEN', 'Admin privileges required.');
  }
  return next();
};

const requireSuperAdmin = (req, res, next) => {
  if (!hasSuperAdminRole(req)) {
    return stdError(res, 403, 'FORBIDDEN', 'Super admin privileges required.');
  }
  return next();
};

router.use(requireAdminRole);

// ─────────────────────────────────────────────
// GET /metrics
// ─────────────────────────────────────────────
router.get('/metrics', async (req, res, next) => {
  try {
    const days = safeDays(req.query.days, 7, 90);
    const feature = req.query.feature || null;

    const data = feature
      ? {
          [feature]: await observabilityRepo.getDailyMetrics(feature, {
            limit: days,
          }),
        }
      : await metricsService.getDashboardSummary({ days });

    return res.json({
      success: true,
      data,
      meta: {
        days,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    return next(err);
  }
});

// ─────────────────────────────────────────────
// GET /drift
// ─────────────────────────────────────────────
router.get('/drift', async (req, res, next) => {
  try {
    const days = safeDays(req.query.days, 30, 90);
    const segment = safeParseJson(req.query.segment);

    const data = await driftService.getDriftReport({
      feature: req.query.feature || null,
      days,
      segment,
    });

    return res.json({
      success: true,
      data,
      meta: {
        days,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    return next(err);
  }
});

// ─────────────────────────────────────────────
// GET /cost
// ─────────────────────────────────────────────
router.get('/cost', async (req, res, next) => {
  try {
    const data = await costTracker.getMonthlySummary(
      req.query.month || null
    );

    return res.json({
      success: true,
      data,
      meta: {
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    return next(err);
  }
});

// ─────────────────────────────────────────────
// GET /alerts
// ─────────────────────────────────────────────
router.get('/alerts', async (req, res, next) => {
  try {
    const limit = safeDays(req.query.limit, 50, 200);

    const data = await observabilityRepo.getActiveAlerts({
      feature: req.query.feature,
      severity: req.query.severity,
      limit,
    });

    return res.json({
      success: true,
      data,
      meta: {
        count: data.length,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    return next(err);
  }
});

// ─────────────────────────────────────────────
// POST /alerts/:id/resolve
// ─────────────────────────────────────────────
router.post('/alerts/:id/resolve', async (req, res, next) => {
  try {
    await observabilityRepo.resolveAlert(
      req.params.id,
      getActorId(req)
    );

    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
});

// ─────────────────────────────────────────────
// GET /sla
// ─────────────────────────────────────────────
router.get('/sla', async (req, res, next) => {
  try {
    const days = safeDays(req.query.days, 30, 90);
    const data = await slaService.getSLAStatus({ days });

    return res.json({
      success: true,
      data,
      meta: {
        days,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    return next(err);
  }
});

// ─────────────────────────────────────────────
// GET /circuit-breaker
// ─────────────────────────────────────────────
router.get('/circuit-breaker', async (req, res, next) => {
  try {
    const [statuses, switchHistory] = await Promise.all([
      Promise.resolve(circuitBreaker.getAllStatuses()),
      observabilityRepo.getModelSwitchHistory({ limit: 20 }),
    ]);

    return res.json({
      success: true,
      data: {
        currentStatuses: statuses,
        recentSwitches: switchHistory,
      },
      meta: {
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    return next(err);
  }
});

// ─────────────────────────────────────────────
// GET /shadow
// ─────────────────────────────────────────────
router.get('/shadow', async (req, res, next) => {
  try {
    const { feature, shadowModel } = req.query;

    if (!feature || !shadowModel) {
      return stdError(
        res,
        400,
        'VALIDATION_ERROR',
        'feature and shadowModel query params are required.'
      );
    }

    const days = safeDays(req.query.days, 14, 30);

    const data = await shadowModelService.getShadowSummary(
      feature,
      shadowModel,
      { days }
    );

    return res.json({
      success: true,
      data,
      meta: {
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    return next(err);
  }
});

// ─────────────────────────────────────────────
// GET /calibration
// ─────────────────────────────────────────────
router.get('/calibration', async (req, res, next) => {
  try {
    const { feature } = req.query;
    const days = safeDays(req.query.days, 30, 90);

    if (feature) {
      const data = await calibrationService.computeCalibration(
        feature,
        { days }
      );

      return res.json({
        success: true,
        data,
        meta: {
          generatedAt: new Date().toISOString(),
        },
      });
    }

    const features = [
      'resume_scoring',
      'salary_benchmark',
      'skill_recommendation',
      'career_path',
    ];

    const results = await Promise.all(
      features.map(async f => [
        f,
        await calibrationService.computeCalibration(f, { days }),
      ])
    );

    const data = Object.fromEntries(results);

    return res.json({
      success: true,
      data,
      meta: {
        days,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    return next(err);
  }
});

// ─────────────────────────────────────────────
// POST /feedback
// ─────────────────────────────────────────────
router.post('/feedback', async (req, res, next) => {
  try {
    const {
      logId,
      userId,
      feature,
      confidenceScore,
      outcome,
      feedbackType,
    } = req.body;

    if (!logId || !feature || outcome == null) {
      return stdError(
        res,
        400,
        'VALIDATION_ERROR',
        'logId, feature, and outcome are required.'
      );
    }

    await calibrationService.recordFeedback({
      logId,
      userId,
      feature,
      confidenceScore,
      outcome,
      feedbackType,
    });

    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
});

// ─────────────────────────────────────────────
// GET /audit
// ─────────────────────────────────────────────
router.get('/audit', requireSuperAdmin, async (req, res, next) => {
  try {
    const days = safeDays(req.query.days, 30, 365);

    const [modelSwitches, slaBreaches, resolvedAlerts] =
      await Promise.all([
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
          totalModelSwitches: modelSwitches.length,
          totalSLABreaches: slaBreaches.length,
          totalResolvedAlerts: resolvedAlerts.length,
          auditPeriodDays: days,
        },
      },
      meta: {
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    return next(err);
  }
});

// ─────────────────────────────────────────────
// POST /aggregate
// ─────────────────────────────────────────────
router.post('/aggregate', requireSuperAdmin, async (req, res, next) => {
  try {
    const dailyWorker = require('../../workers/daily-aggregation.worker');
    const slaWorker = require('../../workers/sla-evaluation.worker');

    const [aggResult, slaResult] = await Promise.all([
      dailyWorker.runJob(req.body.date || null),
      slaWorker.runJob(req.body.date || null),
    ]);

    return res.json({
      success: true,
      data: {
        aggregation: aggResult,
        sla: slaResult,
      },
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;