'use strict';

/**
 * routes/roiAnalysis.routes.js
 *
 * Mount in server.js:
 *   app.use(`${API_PREFIX}/education`, authenticate,
 *     require('./modules/education-intelligence/routes/roiAnalysis.routes'));
 *
 * Endpoints:
 *   POST /api/v1/education/roi-analysis/:studentId  — run ERE, store + return
 *   GET  /api/v1/education/roi-analysis/:studentId  — return stored results
 */

const { Router } = require('express');
const controller = require('../controllers/roiAnalysis.controller');

const router = Router();

router.post('/roi-analysis/:studentId', controller.analyzeROI);
router.get('/roi-analysis/:studentId',  controller.getROI);

module.exports = router;









