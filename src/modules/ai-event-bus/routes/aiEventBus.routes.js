'use strict';

/**
 * aiEventBus.routes.js — AI Event Bus API Routes
 *
 * Registers all event bus endpoints.
 *
 * Mount in server.js — ONE line:
 *   app.use('/api/v1', authenticate,
 *     require('./modules/ai-event-bus/aiEventBus.routes'));
 *
 * IMPORTANT: These routes do NOT replace existing routes.
 * Existing routes (chi-v2, job-seeker, etc.) remain fully functional.
 * These new routes add async behaviour alongside the existing synchronous ones.
 *
 * Endpoints:
 *
 *   POST /api/v1/career/trigger-analysis        — publish CAREER_ANALYSIS_REQUESTED
 *   POST /api/v1/career/trigger-job-match       — publish JOB_MATCH_REQUESTED
 *   POST /api/v1/career/trigger-risk-analysis   — publish RISK_ANALYSIS_REQUESTED
 *   POST /api/v1/career/trigger-opportunity-scan — publish OPPORTUNITY_SCAN_REQUESTED
 *   POST /api/v1/career/trigger-advice          — publish CAREER_ADVICE_REQUESTED
 *
 *   GET  /api/v1/career/intelligence-report     — read merged results
 *   GET  /api/v1/jobs/matches                   — read job match results
 *   GET  /api/v1/career/risk                    — read risk analysis results
 *   GET  /api/v1/career/opportunities           — read opportunity radar results
 *
 *   GET  /api/v1/career/pipeline-status/:jobId  — poll job status
 *
 * @module src/modules/ai-event-bus/aiEventBus.routes
 */

const { Router }  = require('express');
const bus          = require('./bus/aiEventBus');
const resultsSvc   = require('./results/intelligenceResults.service');
const logger       = require('../../utils/logger');

const router = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ok  = (res, data)            => res.status(200).json({ success: true,  data });
const acc = (res, data)            => res.status(202).json({ success: true,  data });
const bad = (res, msg, code = 400) => res.status(code).json({ success: false, error: msg });

function getUserId(req) {
  return req.user?.uid || req.user?.id || null;
}

// ═════════════════════════════════════════════════════════════════════════════
// TRIGGER ENDPOINTS — publish events → 202 Accepted + pipelineJobId
// Dashboard triggers these when requesting fresh analysis.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * POST /career/trigger-analysis
 * Triggers all engines (full pipeline).
 * Use after CV upload or when user explicitly requests a full refresh.
 */
router.post('/career/trigger-analysis', async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return bad(res, 'Unauthenticated', 401);

  try {
    const { pipelineJobId, queuesDispatched } = await bus.publish(
      bus.EVENT_TYPES.CAREER_ANALYSIS_REQUESTED,
      { userId, triggeredBy: 'manual', ...req.body }
    );

    acc(res, {
      pipelineJobId,
      queuesDispatched,
      pollUrl:   `/api/v1/career/pipeline-status/${pipelineJobId}`,
      message:   'Full career analysis queued. Results will be available shortly.',
    });
  } catch (e) {
    logger.error('[EventBusRoute] trigger-analysis error', { userId, err: e.message });
    bad(res, 'Failed to queue analysis', 500);
  }
});

/**
 * POST /career/trigger-job-match
 * Triggers only the job matching worker.
 */
router.post('/career/trigger-job-match', async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return bad(res, 'Unauthenticated', 401);

  try {
    const { pipelineJobId } = await bus.publish(
      bus.EVENT_TYPES.JOB_MATCH_REQUESTED,
      { userId }
    );
    acc(res, { pipelineJobId, pollUrl: `/api/v1/career/pipeline-status/${pipelineJobId}` });
  } catch (e) {
    bad(res, 'Failed to queue job match', 500);
  }
});

/**
 * POST /career/trigger-risk-analysis
 */
router.post('/career/trigger-risk-analysis', async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return bad(res, 'Unauthenticated', 401);

  try {
    const { pipelineJobId } = await bus.publish(
      bus.EVENT_TYPES.RISK_ANALYSIS_REQUESTED,
      { userId }
    );
    acc(res, { pipelineJobId, pollUrl: `/api/v1/career/pipeline-status/${pipelineJobId}` });
  } catch (e) {
    bad(res, 'Failed to queue risk analysis', 500);
  }
});

/**
 * POST /career/trigger-opportunity-scan
 */
router.post('/career/trigger-opportunity-scan', async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return bad(res, 'Unauthenticated', 401);

  try {
    const { pipelineJobId } = await bus.publish(
      bus.EVENT_TYPES.OPPORTUNITY_SCAN_REQUESTED,
      { userId }
    );
    acc(res, { pipelineJobId, pollUrl: `/api/v1/career/pipeline-status/${pipelineJobId}` });
  } catch (e) {
    bad(res, 'Failed to queue opportunity scan', 500);
  }
});

/**
 * POST /career/trigger-advice
 */
router.post('/career/trigger-advice', async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return bad(res, 'Unauthenticated', 401);

  try {
    const { pipelineJobId } = await bus.publish(
      bus.EVENT_TYPES.CAREER_ADVICE_REQUESTED,
      { userId }
    );
    acc(res, { pipelineJobId, pollUrl: `/api/v1/career/pipeline-status/${pipelineJobId}` });
  } catch (e) {
    bad(res, 'Failed to queue career advice', 500);
  }
});

// ─── Internal publisher (called by existing resume/CV pipeline) ───────────────

/**
 * POST /career/internal/cv-parsed  (called by existing ResumeIntelligenceEngine)
 * Publishes CV_PARSED event to fan out to all downstream workers.
 *
 * This is the integration point between the existing synchronous resume
 * pipeline and the new async event bus.
 *
 * In resume.controller.js or resume.service.js, after CV parsing completes:
 *   await fetch('/api/v1/career/internal/cv-parsed', {
 *     method: 'POST',
 *     headers: { Authorization: `Bearer ${internalToken}` },
 *     body: JSON.stringify({ userId, resumeId, skills, parsedData })
 *   });
 */
router.post('/career/internal/cv-parsed', async (req, res) => {
  const { userId, resumeId, skills, parsedData } = req.body;
  if (!userId) return bad(res, 'userId required', 400);

  try {
    const { pipelineJobId, queuesDispatched } = await bus.publish(
      bus.EVENT_TYPES.CV_PARSED,
      { userId, resumeId, skills, parsedData }
    );

    ok(res, { pipelineJobId, queuesDispatched });
  } catch (e) {
    logger.error('[EventBusRoute] cv-parsed error', { userId, err: e.message });
    bad(res, 'Failed to dispatch CV_PARSED event', 500);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// RESULTS ENDPOINTS — read pre-computed results from Supabase + Redis
// Dashboard calls these to display data (never triggers engines directly).
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /career/intelligence-report
 * Returns all available engine results merged into one report.
 */
router.get('/career/intelligence-report', async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return bad(res, 'Unauthenticated', 401);

  try {
    const report = await resultsSvc.getIntelligenceReport(userId);
    ok(res, report);
  } catch (e) {
    logger.error('[EventBusRoute] intelligence-report error', { userId, err: e.message });
    bad(res, 'Failed to load intelligence report', 500);
  }
});

/**
 * GET /jobs/matches
 * Returns latest job match results for the authenticated user.
 */
router.get('/jobs/matches', async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return bad(res, 'Unauthenticated', 401);

  try {
    const result = await resultsSvc.getJobMatches(userId);
    ok(res, result);
  } catch (e) {
    bad(res, 'Failed to load job matches', 500);
  }
});

/**
 * GET /career/risk
 */
router.get('/career/risk', async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return bad(res, 'Unauthenticated', 401);

  try {
    const result = await resultsSvc.getRiskAnalysis(userId);
    ok(res, result);
  } catch (e) {
    bad(res, 'Failed to load risk analysis', 500);
  }
});

/**
 * GET /career/opportunities
 */
router.get('/career/opportunities', async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return bad(res, 'Unauthenticated', 401);

  try {
    const result = await resultsSvc.getOpportunities(userId);
    ok(res, result);
  } catch (e) {
    bad(res, 'Failed to load opportunities', 500);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POLLING ENDPOINT — check job status
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /career/pipeline-status/:jobId
 * Returns the current status of a pipeline job.
 * Frontend polls this after triggering analysis (202 response).
 */
router.get('/career/pipeline-status/:jobId', async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return bad(res, 'Unauthenticated', 401);

  const { jobId } = req.params;

  try {
    const status = await bus.getPipelineStatus(jobId);

    if (!status) {
      return bad(res, 'Pipeline job not found', 404);
    }

    // Verify ownership
    if (status.user_id !== userId && !req.user?.admin) {
      return bad(res, 'Access denied', 403);
    }

    ok(res, {
      pipelineJobId: status.id,
      status:        status.status,
      event_type:    status.event_type,
      queued_at:     status.queued_at,
      started_at:    status.started_at,
      completed_at:  status.completed_at,
      error_message: status.error_message || null,
      is_complete:   status.status === 'completed',
      is_failed:     status.status === 'failed',
    });
  } catch (e) {
    bad(res, 'Failed to get pipeline status', 500);
  }
});

module.exports = router;









