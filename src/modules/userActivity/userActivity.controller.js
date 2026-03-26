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
 */

const { logEvent, getActivitySummary } = require('./userActivity.service');

function _safeUserId(req) {
  return req?.user?.uid ?? req?.user?.id ?? null;
}

// GET /api/v1/user-activity/summary
async function getSummary(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const summary = await getActivitySummary(userId);
    return res.status(200).json({ success: true, data: summary });
  } catch (err) { return next(err); }
}

// POST /api/v1/user-activity/log
async function logUserEvent(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const { eventType, metadata } = req.body;
    await logEvent(userId, eventType, metadata ?? {});
    return res.status(200).json({ success: true });
  } catch (err) { return next(err); }
}

module.exports = { getSummary, logUserEvent };








