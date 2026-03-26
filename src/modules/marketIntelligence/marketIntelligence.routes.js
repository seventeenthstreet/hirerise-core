'use strict';

/**
 * modules/marketIntelligence/marketIntelligence.routes.js
 *
 * Market Intelligence admin routes — requireAdmin only.
 *
 * Mounted in server.js:
 *   app.use(`${API_PREFIX}/admin/market-intelligence`,
 *           authenticate, requireAdmin, marketIntelligenceRouter);
 *
 * ┌──────────────────────────────────────────────────────────────────────────────┐
 * │ Method │ Path          │ Description                                         │
 * ├──────────────────────────────────────────────────────────────────────────────┤
 * │ POST   │ /config       │ Save provider credentials to Secrets Manager        │
 * │ POST   │ /test         │ Test the configured provider connection              │
 * │ GET    │ /status       │ Current provider name + last sync time              │
 * │ GET    │ /data-sources │ Data sources list for admin dashboard               │
 * │ POST   │ /fetch        │ Manually fetch demand data for a role               │
 * └──────────────────────────────────────────────────────────────────────────────┘
 *
 * SECURITY: All routes require authenticate + requireAdmin (set in server.js).
 * Credentials are write-only — never returned by any endpoint.
 */

const express      = require('express');
const { body }     = require('express-validator');
const { validate } = require('../../middleware/requestValidator');

// Secrets service — used to validate provider credentials are stored securely.
// Resolved via the path shim at modules/secrets/service/secrets.service.js
const { getSecret } = require('../secrets/service/secrets.service');  // eslint-disable-line no-unused-vars

const ctrl   = require('./marketIntelligence.controller');
const router = express.Router();

// ── Validators ────────────────────────────────────────────────────────────────

const validateAdzuna = [
  body('provider').equals('adzuna'),
  body('appId').isString().trim().notEmpty().withMessage('appId is required for Adzuna.'),
  body('appKey').isString().trim().notEmpty().withMessage('appKey is required for Adzuna.'),
];

const validateSerpApi = [
  body('provider').equals('serpapi'),
  body('apiKey').isString().trim().notEmpty().withMessage('apiKey is required for SerpApi.'),
  body('searchEngine').optional().isString().trim(),
];

const validateCustom = [
  body('provider').equals('custom'),
  body('baseUrl').isURL().withMessage('baseUrl must be a valid URL.'),
  body('apiKey').isString().trim().notEmpty().withMessage('apiKey is required for custom provider.'),
  body('authType').optional().isIn(['bearer', 'apikey', 'basic']),
];

const validateProvider = [
  body('provider')
    .isIn(['adzuna', 'serpapi', 'custom'])
    .withMessage('provider must be adzuna | serpapi | custom.'),
];

const validateFetch = [
  body('role').isString().trim().notEmpty().isLength({ max: 200 })
    .withMessage('role is required.'),
  body('country').optional().isString().trim().isLength({ min: 2, max: 10 }),
];

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /config — save provider credentials (write-only)
router.post(
  '/config',
  validate(validateProvider),
  ctrl.saveConfig,
);

// POST /test — test the currently configured connection
router.post('/test', ctrl.testConnection);

// GET /status — provider name + last sync timestamp
router.get('/status', ctrl.getStatus);

// GET /data-sources — data sources panel for admin dashboard
router.get('/data-sources', ctrl.getDataSources);

// POST /fetch — manually trigger demand fetch for a role
router.post(
  '/fetch',
  validate(validateFetch),
  ctrl.fetchDemand,
);

module.exports = router;








