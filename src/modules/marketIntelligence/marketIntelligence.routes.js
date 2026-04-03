'use strict';

/**
 * src/modules/marketIntelligence/marketIntelligence.routes.js
 *
 * Market Intelligence admin routes.
 *
 * Security:
 * - Mounted behind authenticate + requireAdmin in server.js
 * - Credentials remain write-only
 * - Controller/service layer remains storage-agnostic
 *
 * Supabase migration:
 * - No Firebase assumptions
 * - No secret-manager shim dependencies
 * - Validation normalized for row-based providers
 */

const express = require('express');
const { body } = require('express-validator');
const { validate } = require('../../middleware/requestValidator');
const ctrl = require('./marketIntelligence.controller');

const router = express.Router();

/**
 * Shared provider validation.
 */
const providerValidator = body('provider')
  .isIn(['adzuna', 'serpapi', 'custom'])
  .withMessage('provider must be adzuna | serpapi | custom.');

/**
 * POST /config validator
 * Supports all provider credential shapes.
 */
const validateConfig = [
  providerValidator,

  body('appId')
    .if(body('provider').equals('adzuna'))
    .isString()
    .trim()
    .notEmpty()
    .withMessage('appId is required for Adzuna.'),

  body('appKey')
    .if(body('provider').equals('adzuna'))
    .isString()
    .trim()
    .notEmpty()
    .withMessage('appKey is required for Adzuna.'),

  body('apiKey')
    .if(body('provider').isIn(['serpapi', 'custom']))
    .isString()
    .trim()
    .notEmpty()
    .withMessage('apiKey is required for serpapi/custom provider.'),

  body('searchEngine')
    .optional()
    .isString()
    .trim(),

  body('baseUrl')
    .if(body('provider').equals('custom'))
    .isURL()
    .withMessage('baseUrl must be a valid URL.'),

  body('authType')
    .optional()
    .isIn(['bearer', 'apikey', 'basic'])
    .withMessage('authType must be bearer | apikey | basic.'),
];

/**
 * POST /fetch validator
 */
const validateFetch = [
  body('role')
    .isString()
    .trim()
    .notEmpty()
    .isLength({ max: 200 })
    .withMessage('role is required.'),

  body('country')
    .optional()
    .isString()
    .trim()
    .isLength({ min: 2, max: 10 })
    .withMessage('country must be between 2 and 10 characters.'),
];

/**
 * POST /config
 * Save provider credentials.
 */
router.post(
  '/config',
  validate(validateConfig),
  ctrl.saveConfig,
);

/**
 * POST /test
 * Test provider connectivity.
 */
router.post('/test', ctrl.testConnection);

/**
 * GET /status
 * Current provider + last sync metadata.
 */
router.get('/status', ctrl.getStatus);

/**
 * GET /data-sources
 * Admin dashboard data source listing.
 */
router.get('/data-sources', ctrl.getDataSources);

/**
 * POST /fetch
 * Trigger demand sync for a role.
 */
router.post(
  '/fetch',
  validate(validateFetch),
  ctrl.fetchDemand,
);

module.exports = router;