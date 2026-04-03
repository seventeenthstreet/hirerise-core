'use strict';

/**
 * src/modules/qualification/qualification.routes.js
 *
 * Qualification routes
 * --------------------
 * GET /api/v1/qualifications
 * Returns all active qualifications for onboarding dropdowns.
 *
 * Mount in server.js:
 * app.use(
 *   `${API_PREFIX}/qualifications`,
 *   authenticate,
 *   require('./modules/qualification/qualification.routes')
 * );
 */

const express = require('express');
const { listActiveQualifications } = require('./qualification.service');

const router = express.Router();

/**
 * Lightweight local async wrapper
 * Avoids external utils dependency resolution issues
 */
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/**
 * GET /
 * Fetch active qualifications
 */
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const qualifications = await listActiveQualifications();

    return res.status(200).json({
      success: true,
      data: Array.isArray(qualifications) ? qualifications : [],
    });
  })
);

module.exports = router;