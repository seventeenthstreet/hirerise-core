'use strict';

/**
 * routes/careerSimulation.routes.js
 *
 * Mount in server.js:
 *   app.use(`${API_PREFIX}/education`, authenticate,
 *     require('./modules/education-intelligence/routes/careerSimulation.routes'));
 */

const { Router } = require('express');
const controller = require('../controllers/careerSimulation.controller');

const router = Router();

router.post('/career-simulation/:studentId', controller.simulateCareers);
router.get('/career-simulation/:studentId',  controller.getSimulations);

module.exports = router;









