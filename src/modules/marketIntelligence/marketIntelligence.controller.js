'use strict';

/**
 * src/modules/marketIntelligence/marketIntelligence.controller.js
 *
 * Thin HTTP controller layer for Market Intelligence.
 * Business logic remains exclusively inside the service layer.
 *
 * Supabase migration notes:
 * - No Firebase dependencies remain
 * - No Firestore snapshot assumptions
 * - Controller remains storage-agnostic
 * - Safe for row-based Supabase services
 */

const svc = require('./marketIntelligence.service');
const logger = require('../../utils/logger');

/**
 * Standard async controller wrapper.
 * Ensures consistent Express error forwarding.
 *
 * @param {Function} fn
 * @returns {Function}
 */
function asyncHandler(fn) {
  return function wrappedController(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Extract authenticated actor ID safely.
 * Supports multiple auth middleware strategies.
 *
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function getActorId(req) {
  return req?.user?.uid || req?.user?.id || null;
}

/**
 * Standard success response helper.
 *
 * @param {import('express').Response} res
 * @param {object} payload
 * @param {number} [statusCode=200]
 */
function sendSuccess(res, payload, statusCode = 200) {
  return res.status(statusCode).json({
    success: true,
    ...payload,
  });
}

/**
 * POST /api/v1/admin/market-intelligence/config
 */
const saveConfig = asyncHandler(async (req, res) => {
  const adminUid = getActorId(req);

  logger.info('Saving market intelligence config', {
    actorId: adminUid,
  });

  const result = await svc.saveConfig(req.body, adminUid);

  return sendSuccess(res, result);
});

/**
 * POST /api/v1/admin/market-intelligence/test
 */
const testConnection = asyncHandler(async (_req, res) => {
  const result = await svc.testConnection();
  return sendSuccess(res, result);
});

/**
 * GET /api/v1/admin/market-intelligence/status
 */
const getStatus = asyncHandler(async (_req, res) => {
  const result = await svc.getStatus();
  return sendSuccess(res, result);
});

/**
 * GET /api/v1/admin/market-intelligence/data-sources
 */
const getDataSources = asyncHandler(async (_req, res) => {
  const result = await svc.getDataSources();
  return sendSuccess(res, result);
});

/**
 * POST /api/v1/admin/market-intelligence/fetch
 */
const fetchDemand = asyncHandler(async (req, res) => {
  const role =
    typeof req.body?.role === 'string'
      ? req.body.role.trim()
      : '';

  const country =
    typeof req.body?.country === 'string' && req.body.country.trim()
      ? req.body.country.trim().toLowerCase()
      : 'in';

  if (!role) {
    return res.status(400).json({
      success: false,
      error: 'role is required.',
    });
  }

  logger.info('Fetching market demand', {
    role,
    country,
    actorId: getActorId(req),
  });

  const result = await svc.fetchDemand(role, country);

  return sendSuccess(res, result);
});

module.exports = {
  saveConfig,
  testConnection,
  getStatus,
  getDataSources,
  fetchDemand,
};