'use strict';

/**
 * modules/knowledge-runtime/decision/decision.routes.js
 *
 * Mounted at: /api/v1/decisions (see server.js — mounted behind the
 * existing `authenticate` middleware, matching the Knowledge/Student/
 * Recommendation/Validation runtime precedent).
 *
 * Endpoints:
 *   GET /me?decisionType=<type> — current caller's Decision for the given
 *                                 decisionType (see decision.validator.js
 *                                 VALID_DECISION_TYPES for the accepted set)
 */

const { Router } = require('express');
const decisionController = require('./decision.controller');

const router = Router();

router.get('/me', decisionController.decideMine);

module.exports = Object.freeze(router);
