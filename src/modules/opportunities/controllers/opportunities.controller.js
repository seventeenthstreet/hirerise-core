'use strict';

/**
 * controllers/opportunities.controller.js
 *
 * Student-facing Opportunities endpoint.
 *
 * GET /api/v1/opportunities/:studentId
 *
 * Returns matched university programs and job roles for a student.
 * Students can only fetch their own opportunities (UID check).
 * Admins can fetch any student's opportunities.
 */

const logger          = require('../../../utils/logger');
const matchingService = require('../services/studentMatching.service');

function ok(res, data) {
  return res.status(200).json({ success: true, data });
}
function fail(res, statusCode, message, code = 'OPPORTUNITIES_ERROR') {
  return res.status(statusCode).json({ success: false, error: { message, code } });
}

async function getOpportunities(req, res) {
  const { studentId } = req.params;

  // Authorization: student can only see their own opportunities
  const isAdmin = req.user?.admin === true || req.user?.role === 'admin';
  if (!isAdmin && req.user.uid !== studentId) {
    return fail(res, 403, 'You can only view your own opportunities.', 'FORBIDDEN');
  }

  try {
    const result = await matchingService.getOpportunities(studentId);
    return ok(res, result);
  } catch (err) {
    logger.error({ err: err.message, studentId }, '[OpportunitiesController] getOpportunities');
    return fail(res, err.statusCode || 500, err.message);
  }
}

module.exports = { getOpportunities };









