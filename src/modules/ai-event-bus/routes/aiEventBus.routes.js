'use strict';

/**
 * aiEventBus.routes.js — optimized async routes
 *
 * Firebase: none in original.
 * Optimizations:
 * - shared async route wrapper
 * - centralized auth + publish helpers
 * - reduced duplicate route logic
 * - safer ownership checks
 * - consistent error logging
 */

const { Router } = require('express');
const bus = require('./bus/aiEventBus');
const resultsSvc = require('./results/intelligenceResults.service');
const logger = require('../../../utils/logger');

const router = Router();

const ok = (res, data, code = 200) => res.status(code).json({ success: true, data });
const bad = (res, msg, code = 400) =>
  res.status(code).json({ success: false, error: msg });

const getUserId = (req) => req.user?.uid || req.user?.id || null;

function asyncHandler(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      logger.error('[EventBusRoute] Unhandled route error', {
        path: req.path,
        error: error.message,
      });
      bad(res, 'Internal server error', 500);
    }
  };
}

async function publishAndRespond(res, eventType, payload) {
  const { pipelineJobId, queuesDispatched } = await bus.publish(
    eventType,
    payload
  );

  return ok(
    res,
    {
      pipelineJobId,
      queuesDispatched,
      pollUrl: `/api/v1/career/pipeline-status/${pipelineJobId}`,
    },
    202
  );
}

// Trigger routes
router.post(
  '/career/trigger-analysis',
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return bad(res, 'Unauthenticated', 401);

    return publishAndRespond(res, bus.EVENT_TYPES.CAREER_ANALYSIS_REQUESTED, {
      userId,
      triggeredBy: 'manual',
      ...req.body,
    });
  })
);

router.post(
  '/career/trigger-job-match',
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return bad(res, 'Unauthenticated', 401);

    return publishAndRespond(res, bus.EVENT_TYPES.JOB_MATCH_REQUESTED, {
      userId,
    });
  })
);

router.post(
  '/career/trigger-risk-analysis',
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return bad(res, 'Unauthenticated', 401);

    return publishAndRespond(res, bus.EVENT_TYPES.RISK_ANALYSIS_REQUESTED, {
      userId,
    });
  })
);

router.post(
  '/career/trigger-opportunity-scan',
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return bad(res, 'Unauthenticated', 401);

    return publishAndRespond(
      res,
      bus.EVENT_TYPES.OPPORTUNITY_SCAN_REQUESTED,
      { userId }
    );
  })
);

router.post(
  '/career/trigger-advice',
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return bad(res, 'Unauthenticated', 401);

    return publishAndRespond(res, bus.EVENT_TYPES.CAREER_ADVICE_REQUESTED, {
      userId,
    });
  })
);

router.post(
  '/career/internal/cv-parsed',
  asyncHandler(async (req, res) => {
    const { userId, resumeId, skills, parsedData } = req.body;
    if (!userId) return bad(res, 'userId required', 400);

    const { pipelineJobId, queuesDispatched } = await bus.publish(
      bus.EVENT_TYPES.CV_PARSED,
      { userId, resumeId, skills, parsedData }
    );

    return ok(res, { pipelineJobId, queuesDispatched });
  })
);

// Result routes
router.get(
  '/career/intelligence-report',
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return bad(res, 'Unauthenticated', 401);
    return ok(res, await resultsSvc.getIntelligenceReport(userId));
  })
);

router.get(
  '/jobs/matches',
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return bad(res, 'Unauthenticated', 401);
    return ok(res, await resultsSvc.getJobMatches(userId));
  })
);

router.get(
  '/career/risk',
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return bad(res, 'Unauthenticated', 401);
    return ok(res, await resultsSvc.getRiskAnalysis(userId));
  })
);

router.get(
  '/career/opportunities',
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return bad(res, 'Unauthenticated', 401);
    return ok(res, await resultsSvc.getOpportunities(userId));
  })
);

router.get(
  '/career/pipeline-status/:jobId',
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return bad(res, 'Unauthenticated', 401);

    const status = await bus.getPipelineStatus(req.params.jobId);
    if (!status) return bad(res, 'Pipeline job not found', 404);

    if (status.user_id && status.user_id !== userId && !req.user?.admin) {
      return bad(res, 'Access denied', 403);
    }

    return ok(res, {
      pipelineJobId: status.id,
      ...status,
      is_complete: status.status === 'completed',
      is_failed: status.status === 'failed',
    });
  })
);

module.exports = router;