'use strict';

/**
 * userActivity.controller.js
 *
 * GET /api/v1/user-activity/summary
 *   Returns streak, weekly actions, and 7-day activity map for the
 *   authenticated user. Used by the dashboard streak component.
 *
 * POST /api/v1/user-activity/log
 *   Internal endpoint — logs a user action event.
 *   Also called directly from other services via logEvent().
 *
 * Supabase Migration Notes:
 * - Fully removes Firebase-specific auth assumptions
 * - Uses normalized authenticated user extraction
 * - Improves null safety and request validation
 * - Keeps API response shape fully backward compatible
 */

const {
  logEvent,
  getActivitySummary,
} = require('./userActivity.service');

/**
 * Safely extracts authenticated user id.
 *
 * Supabase standard: req.user.id
 * Legacy fallback kept temporarily for safe rollout compatibility.
 *
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function getAuthenticatedUserId(req) {
  return req?.user?.id ?? req?.user?.uid ?? null;
}

/**
 * Standard unauthorized response helper.
 *
 * @param {import('express').Response} res
 * @returns {import('express').Response}
 */
function unauthorized(res) {
  return res.status(401).json({
    success: false,
    message: 'Unauthorized',
  });
}

/**
 * GET /api/v1/user-activity/summary
 */
async function getSummary(req, res, next) {
  try {
    const userId = getAuthenticatedUserId(req);
    if (!userId) return unauthorized(res);

    const summary = await getActivitySummary(userId);

    return res.status(200).json({
      success: true,
      data: summary,
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /api/v1/user-activity/log
 */
async function logUserEvent(req, res, next) {
  try {
    const userId = getAuthenticatedUserId(req);
    if (!userId) return unauthorized(res);

    const eventType =
      typeof req.body?.eventType === 'string'
        ? req.body.eventType.trim()
        : '';

    if (!eventType) {
      return res.status(400).json({
        success: false,
        message: 'eventType is required',
      });
    }

    const metadata =
      req.body?.metadata &&
      typeof req.body.metadata === 'object' &&
      !Array.isArray(req.body.metadata)
        ? req.body.metadata
        : {};

    await logEvent(userId, eventType, metadata);

    return res.status(200).json({
      success: true,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getSummary,
  logUserEvent,
};