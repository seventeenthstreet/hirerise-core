'use strict';

/**
 * modules/marketIntelligence/marketIntelligence.controller.js
 *
 * Thin HTTP layer — delegates all logic to marketIntelligence.service.js.
 * Credentials are NEVER logged or returned in responses.
 */

const svc = require('./marketIntelligence.service');

/** POST /api/v1/admin/market-intelligence/config */
async function saveConfig(req, res, next) {
  try {
    const adminUid = req.user?.uid || req.user?.id;
    const result   = await svc.saveConfig(req.body, adminUid);
    res.status(200).json({ success: true, ...result });
  } catch (err) { next(err); }
}

/** POST /api/v1/admin/market-intelligence/test */
async function testConnection(req, res, next) {
  try {
    const result = await svc.testConnection();
    res.status(200).json({ success: true, ...result });
  } catch (err) { next(err); }
}

/** GET /api/v1/admin/market-intelligence/status */
async function getStatus(req, res, next) {
  try {
    const result = await svc.getStatus();
    res.status(200).json({ success: true, ...result });
  } catch (err) { next(err); }
}

/** GET /api/v1/admin/market-intelligence/data-sources */
async function getDataSources(req, res, next) {
  try {
    const result = await svc.getDataSources();
    res.status(200).json({ success: true, ...result });
  } catch (err) { next(err); }
}

/** POST /api/v1/admin/market-intelligence/fetch */
async function fetchDemand(req, res, next) {
  try {
    const { role, country = 'in' } = req.body;
    if (!role || typeof role !== 'string') {
      return res.status(400).json({ success: false, error: 'role is required.' });
    }
    const result = await svc.fetchDemand(role.trim(), country);
    res.status(200).json({ success: true, ...result });
  } catch (err) { next(err); }
}

module.exports = { saveConfig, testConnection, getStatus, getDataSources, fetchDemand };








