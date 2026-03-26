'use strict';

/**
 * opportunityRadar.controller.js
 *
 * HTTP handlers for the AI Career Opportunity Radar endpoints.
 *
 * Routes handled (mounted at /api/v1):
 *   GET  /career/opportunity-radar        — personalised radar for auth user
 *   GET  /career/emerging-roles           — public catalogue of emerging roles
 *   POST /career/opportunity-radar/refresh — trigger signal refresh (admin)
 *
 * @module src/modules/opportunityRadar/opportunityRadar.controller
 */

'use strict';

const logger  = require('../../utils/logger');
const engine  = require('../../engines/opportunityRadar.engine');

// ─── Response helpers ─────────────────────────────────────────────────────────

const ok  = (res, data)              => res.status(200).json({ success: true,  data });
const bad = (res, msg, code = 400)   => res.status(code).json({ success: false, error: msg });
const err = (res, msg, code = 500)   => res.status(code).json({ success: false, error: msg });

// ─── GET /career/opportunity-radar ────────────────────────────────────────────

/**
 * Returns personalised emerging career opportunities for the authenticated user.
 *
 * Query params:
 *   limit               — max results (default 10, max 30)
 *   minOpportunityScore — filter by min opportunity score (default 40)
 *   minMatchScore       — filter by min user match score  (default 0)
 *
 * Example:
 *   GET /api/v1/career/opportunity-radar?limit=5&minOpportunityScore=60
 */
async function getOpportunityRadar(req, res) {
  const userId = req.user?.uid || req.user?.id;
  if (!userId) return bad(res, 'Unauthenticated', 401);

  const topN               = Math.min(parseInt(req.query.limit)               || 10, 30);
  const minOpportunityScore = parseInt(req.query.minOpportunityScore)         || 40;
  const minMatchScore       = parseInt(req.query.minMatchScore)               || 0;

  try {
    const result = await engine.getOpportunityRadar(userId, {
      topN,
      minOpportunityScore,
      minMatchScore,
    });

    ok(res, result);
  } catch (e) {
    logger.error('[OpportunityRadar] getOpportunityRadar handler error', {
      userId, err: e.message,
    });
    err(res, 'Failed to load opportunity radar');
  }
}

// ─── GET /career/emerging-roles ───────────────────────────────────────────────

/**
 * Returns the public catalogue of top emerging career roles.
 * Not personalised — no auth required beyond basic session.
 *
 * Query params:
 *   limit        — max results (default 20, max 50)
 *   industry     — filter by industry string (optional)
 *   emergingOnly — 'true' to return only is_emerging=true roles
 *   minScore     — min opportunity_score (default 60)
 *
 * Example:
 *   GET /api/v1/career/emerging-roles?emergingOnly=true&minScore=70
 */
async function getEmergingRoles(req, res) {
  const limit        = Math.min(parseInt(req.query.limit) || 20, 50);
  const industry     = req.query.industry     ? String(req.query.industry)  : null;
  const emergingOnly = req.query.emergingOnly === 'true';
  const minScore     = parseInt(req.query.minScore) || 60;

  try {
    const result = await engine.getEmergingRoles({ limit, industry, emergingOnly, minScore });
    ok(res, result);
  } catch (e) {
    logger.error('[OpportunityRadar] getEmergingRoles handler error', { err: e.message });
    err(res, 'Failed to load emerging roles');
  }
}

// ─── POST /career/opportunity-radar/refresh (admin) ──────────────────────────

/**
 * Triggers a full refresh of opportunity signals from LMI data.
 * Requires admin role.
 */
async function refreshSignals(req, res) {
  if (!req.user?.admin) {
    return bad(res, 'Admin access required', 403);
  }

  try {
    const result = await engine.detectOpportunitySignals();
    ok(res, {
      message:    'Opportunity signals refreshed successfully',
      upserted:   result.upserted,
      total:      result.total,
      duration_ms: result.duration_ms,
    });
  } catch (e) {
    logger.error('[OpportunityRadar] refreshSignals handler error', { err: e.message });
    err(res, 'Signal refresh failed');
  }
}

module.exports = { getOpportunityRadar, getEmergingRoles, refreshSignals };









