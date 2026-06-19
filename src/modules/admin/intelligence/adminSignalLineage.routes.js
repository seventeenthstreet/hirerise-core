'use strict';

/**
 * core/src/modules/admin/intelligence/adminSignalLineage.routes.js
 *
 * Admin Signal Lineage Routes
 * A09 — Phase 2A.1.3
 *
 * Endpoint:
 *   GET /api/v1/intelligence/admin/signal-lineage/:signal_key
 *
 * Mount:
 *
 * app.use(
 *   `${API_PREFIX}/intelligence/admin`,
 *   authenticate,
 *   requireAdmin,
 *   require('./modules/admin/intelligence/adminSignalLineage.routes')
 * );
 *
 * Security:
 * - Authentication enforced at mount level.
 * - Admin authorization enforced at mount level.
 * - Request validation enforced via express-validator.
 *
 * Notes:
 * - Read-only governance endpoint.
 * - Empty lineage results return HTTP 200.
 * - Unknown signal keys do not return 404.
 */

const express = require('express');
const { param } = require('express-validator');

const { validate } = require('../../../middleware/requestValidator');
const controller = require('./adminSignalLineage.controller');

const router = express.Router();

/**
 * signal_key validation
 *
 * Examples:
 *   skills.data_analysis
 *   skills.data_analysis.advanced
 *   SIGNAL_V2
 *   signal-name
 */
const signalKeyValidator = param('signal_key')
  .trim()
  .notEmpty()
  .withMessage('signal_key is required')
  .isLength({ max: 200 })
  .withMessage('signal_key must not exceed 200 characters')
  .matches(/^[A-Za-z0-9._-]+$/)
  .withMessage('signal_key contains invalid characters');

/**
 * GET /signal-lineage/:signal_key
 *
 * Returns lineage summary records for a signal key.
 *
 * Authentication:
 *   authenticate (server mount)
 *
 * Authorization:
 *   requireAdmin (server mount)
 *
 * Response:
 * {
 *   success: true,
 *   data: {
 *     signalKey,
 *     lineage,
 *     total
 *   },
 *   meta: {
 *     duration_ms
 *   }
 * }
 */
router.get(
  '/signal-lineage/:signal_key',
  validate([signalKeyValidator]),
  controller.getSignalLineage
);

module.exports = router;