'use strict';

/**
 * routes/opportunities.routes.js
 *
 * Mount in server.js:
 *
 *   app.use(
 *     `${API_PREFIX}/opportunities`,
 *     authenticate,
 *     require('./modules/opportunities/routes/opportunities.routes')
 *   );
 *
 * ── Endpoint Map ──────────────────────────────────────────────────────────────
 *
 *   GET /api/v1/opportunities/:studentId
 *
 *   Response:
 *   {
 *     student_id: "...",
 *     universities: [
 *       { program: "BTech Computer Science", university: "XYZ University",
 *         degree_type: "BTech", duration_years: 4, tuition_cost: 12000,
 *         country: "India", match_score: 87 }
 *     ],
 *     jobs: [
 *       { role: "Software Engineer", company: "TechCorp",
 *         industry: "Technology", salary_range: {...}, match_score: 82 }
 *     ]
 *   }
 */

const { Router }     = require('express');
const controller     = require('../controllers/opportunities.controller');

const router = Router();

router.get('/:studentId', controller.getOpportunities);

module.exports = router;









