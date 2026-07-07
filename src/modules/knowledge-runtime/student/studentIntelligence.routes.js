'use strict';

/**
 * modules/knowledge-runtime/student/studentIntelligence.routes.js
 *
 * Mounted at: /api/v1/student-context (see server.js — mounted behind the
 * existing `authenticate` middleware, matching the knowledge-runtime
 * precedent from WP-IMP-02). Route prefix intentionally uses WP-IMP-03's
 * "student-context" terminology at the API surface, even though the
 * underlying module/class follow the frozen `student/studentIntelligence.*`
 * naming — reconciling the WP's naming preference with the frozen
 * architecture contract without conflicting with either.
 *
 * Endpoints:
 *   GET  /me                — current caller's full student context
 *   GET  /me/academic        — academic snapshot slice
 *   GET  /me/career           — career snapshot slice
 *   GET  /me/skills            — skill snapshot slice
 *   GET  /me/future              — future/goals+readiness snapshot slice
 *   GET  /me/readiness             — readiness snapshot slice
 *   POST /me/refresh                — invalidate cache + re-read (Objective 6)
 *   GET  /:userId                     — admin-only, arbitrary student's context
 *
 * All /me/* routes resolve identity from req.user.id (set by `authenticate`)
 * — never from a client-supplied id, since BaseRepository bypasses RLS (see
 * controller header for why this matters).
 */

const { Router } = require('express');
const { requireAdmin } = require('../../../middleware/auth.middleware');
const studentContextController = require('./studentIntelligence.controller');

const router = Router();

// ── Self-scoped ──────────────────────────────────────────────────────────
router.get('/me/academic', studentContextController.getMyAcademicSnapshot);
router.get('/me/career', studentContextController.getMyCareerSnapshot);
router.get('/me/skills', studentContextController.getMySkillSnapshot);
router.get('/me/future', studentContextController.getMyFutureSnapshot);
router.get('/me/readiness', studentContextController.getMyReadinessSnapshot);
router.post('/me/refresh', studentContextController.refreshMyContext);
router.get('/me', studentContextController.getMyContext);

// ── Admin-only ───────────────────────────────────────────────────────────
router.get('/:userId', requireAdmin, studentContextController.getStudentContextByUserId);

module.exports = Object.freeze(router);
