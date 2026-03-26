'use strict';

/**
 * routes/advisor.routes.js
 *
 * Mount in server.js BEFORE the 404 handler:
 *
 *   app.use(
 *     `${API_PREFIX}/advisor`,
 *     authenticate,
 *     require('./modules/ai-career-advisor/routes/advisor.routes')
 *   );
 *
 * Endpoints:
 *   POST /api/v1/advisor/chat/:studentId      → AI response to student question
 *   GET  /api/v1/advisor/welcome/:studentId   → welcome message (no AI call)
 *   GET  /api/v1/advisor/history/:studentId   → conversation history
 */

const { Router }    = require('express');
const controller    = require('../controllers/advisor.controller');

const router = Router();

/**
 * POST /api/v1/advisor/chat/:studentId
 *
 * Body: { message: string }
 *
 * Returns:
 *   { success: true, data: { response: string, studentName: string|null } }
 */
router.post('/chat/:studentId', controller.chat);

/**
 * GET /api/v1/advisor/welcome/:studentId
 *
 * Returns the personalised welcome message shown on advisor page load.
 * Zero latency — no AI call involved.
 *
 * Returns:
 *   { success: true, data: { message: string, studentName: string|null } }
 */
router.get('/welcome/:studentId', controller.welcome);

/**
 * GET /api/v1/advisor/history/:studentId
 *
 * Returns the last 20 conversation turns for the student.
 *
 * Returns:
 *   { success: true, data: { conversations: ConversationDoc[] } }
 */
router.get('/history/:studentId', controller.history);

module.exports = router;









