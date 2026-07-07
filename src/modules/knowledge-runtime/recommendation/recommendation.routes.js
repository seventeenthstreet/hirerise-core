'use strict';

/**
 * modules/knowledge-runtime/recommendation/recommendation.routes.js
 *
 * Mounted at: /api/v1/recommendations (see server.js — mounted behind the
 * existing `authenticate` middleware, matching the Knowledge/Student
 * runtime precedent).
 *
 * Endpoints:
 *   GET /me                — current caller's deterministic candidate set
 *                            Query: ?groups=skill,career (optional; omit for all groups)
 */

const { Router } = require('express');
const recommendationController = require('./recommendation.controller');

const router = Router();

router.get('/me', recommendationController.getMyRecommendations);

module.exports = Object.freeze(router);
