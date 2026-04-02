'use strict';

/**
 * routes/advisor.routes.js
 *
 * Mount in server.js:
 *
 * app.use(
 *   `${API_PREFIX}/advisor`,
 *   authenticateSupabase,
 *   require('./modules/ai-career-advisor/routes/advisor.routes')
 * );
 *
 * Endpoints:
 *   POST /chat/:studentId
 *   GET  /welcome/:studentId
 *   GET  /history/:studentId
 */

const { Router } = require('express');
const controller = require('../controllers/advisor.controller');

const router = Router();

// ─────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────
router.post('/chat/:studentId', controller.chat);
router.get('/welcome/:studentId', controller.welcome);
router.get('/history/:studentId', controller.history);

module.exports = router;