'use strict';

/**
 * src/modules/opportunityRadar/opportunityRadar.controller.js
 *
 * HTTP handlers for the AI Career Opportunity Radar endpoints.
 *
 * Routes handled (mounted at /api/v1):
 *   GET  /career/opportunity-radar         — personalised radar for auth user
 *   GET  /career/emerging-roles            — public catalogue of emerging roles
 *   POST /career/opportunity-radar/refresh — trigger signal refresh (admin)
 *
 * Supabase migration notes:
 * - Removed Firebase-style auth assumptions
 * - Supports Supabase JWT user payload conventions
 * - Hardened query parsing and null safety
 * - Improved structured logging consistency
 * - Preserves existing API response shape
 */

const logger = require('../../utils/logger');
const engine = require('../../engines/opportunityRadar.engine');

// ───────────────────────────────────────────────────────────────────────────────
// Response helpers
// ───────────────────────────────────────────────────────────────────────────────

function sendSuccess(res, data, statusCode = 200) {
  return res.status(statusCode).json({
    success: true,
    data,
  });
}

function sendError(res, message, statusCode = 500, meta = undefined) {
  return res.status(statusCode).json({
    success: false,
    error: message,
    ...(meta ? { meta } : {}),
  });
}

// ───────────────────────────────────────────────────────────────────────────────
// Query helpers
// ───────────────────────────────────────────────────────────────────────────────

function parseInteger(value, fallback, { min = null, max = null } = {}) {
  const parsed = Number.parseInt(value, 10);

  if (Number.isNaN(parsed)) return fallback;

  let safeValue = parsed;

  if (min !== null) safeValue = Math.max(min, safeValue);
  if (max !== null) safeValue = Math.min(max, safeValue);

  return safeValue;
}

function parseBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return fallback;

  const normalized = value.trim().toLowerCase();

  if (['true', '1', 'yes'].includes(normalized)) return true;
  if (['false', '0', 'no'].includes(normalized)) return false;

  return fallback;
}

function getAuthenticatedUserId(req) {
  /**
   * Supabase auth payload compatibility:
   * - req.user.id       → preferred standard
   * - req.user.sub      → JWT subject fallback
   * - req.user.uid      → legacy compatibility kept for drop-in safety
   */
  return req.user?.id || req.user?.sub || req.user?.uid || null;
}

function isAdmin(req) {
  /**
   * Supports multiple admin claim conventions:
   * - req.user.admin === true
   * - req.user.role === 'admin'
   * - req.user.app_metadata.role === 'admin'
   */
  return Boolean(
    req.user?.admin === true ||
    req.user?.role === 'admin' ||
    req.user?.app_metadata?.role === 'admin'
  );
}

// ───────────────────────────────────────────────────────────────────────────────
// GET /career/opportunity-radar
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Returns personalised emerging career opportunities for the authenticated user.
 *
 * Query params:
 *   limit               — max results (default 10, max 30)
 *   minOpportunityScore — minimum opportunity score (default 40)
 *   minMatchScore       — minimum user match score (default 0)
 */
async function getOpportunityRadar(req, res) {
  const userId = getAuthenticatedUserId(req);

  if (!userId) {
    return sendError(res, 'Unauthenticated', 401);
  }

  const topN = parseInteger(req.query.limit, 10, { min: 1, max: 30 });
  const minOpportunityScore = parseInteger(
    req.query.minOpportunityScore,
    40,
    { min: 0, max: 100 }
  );
  const minMatchScore = parseInteger(
    req.query.minMatchScore,
    0,
    { min: 0, max: 100 }
  );

  try {
    const result = await engine.getOpportunityRadar(userId, {
      topN,
      minOpportunityScore,
      minMatchScore,
    });

    return sendSuccess(res, result);
  } catch (error) {
    logger.error('[OpportunityRadarController] getOpportunityRadar failed', {
      userId,
      error: error.message,
      stack: error.stack,
      query: req.query,
    });

    return sendError(res, 'Failed to load opportunity radar', 500);
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// GET /career/emerging-roles
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Returns the public catalogue of top emerging career roles.
 *
 * Query params:
 *   limit        — max results (default 20, max 50)
 *   industry     — optional string filter
 *   emergingOnly — boolean
 *   minScore     — minimum opportunity score (default 60)
 */
async function getEmergingRoles(req, res) {
  const limit = parseInteger(req.query.limit, 20, { min: 1, max: 50 });
  const industry = req.query.industry
    ? String(req.query.industry).trim()
    : null;
  const emergingOnly = parseBoolean(req.query.emergingOnly, false);
  const minScore = parseInteger(req.query.minScore, 60, {
    min: 0,
    max: 100,
  });

  try {
    const result = await engine.getEmergingRoles({
      limit,
      industry,
      emergingOnly,
      minScore,
    });

    return sendSuccess(res, result);
  } catch (error) {
    logger.error('[OpportunityRadarController] getEmergingRoles failed', {
      error: error.message,
      stack: error.stack,
      query: req.query,
    });

    return sendError(res, 'Failed to load emerging roles', 500);
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// POST /career/opportunity-radar/refresh
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Triggers a full refresh of opportunity signals from LMI data.
 * Requires admin privileges.
 */
async function refreshSignals(req, res) {
  if (!isAdmin(req)) {
    return sendError(res, 'Admin access required', 403);
  }

  try {
    const result = await engine.detectOpportunitySignals();

    return sendSuccess(res, {
      message: 'Opportunity signals refreshed successfully',
      upserted: result?.upserted ?? 0,
      total: result?.total ?? 0,
      duration_ms: result?.duration_ms ?? 0,
    });
  } catch (error) {
    logger.error('[OpportunityRadarController] refreshSignals failed', {
      error: error.message,
      stack: error.stack,
      userId: getAuthenticatedUserId(req),
    });

    return sendError(res, 'Signal refresh failed', 500);
  }
}

module.exports = {
  getOpportunityRadar,
  getEmergingRoles,
  refreshSignals,
};