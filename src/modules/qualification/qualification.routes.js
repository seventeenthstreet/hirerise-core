'use strict';

/**
 * qualification.routes.js
 *
 * GET /api/v1/qualifications — list all active qualifications for onboarding dropdowns.
 *
 * Registration in server.js:
 *   app.use(`${API_PREFIX}/qualifications`, authenticate, require('./modules/qualification/qualification.routes'));
 */

const express = require('express');
const { listActiveQualifications } = require('./qualification.service');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const qualifications = await listActiveQualifications();
    return res.status(200).json({ success: true, data: qualifications });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
