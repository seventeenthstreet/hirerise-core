'use strict';

/**
 * modules/knowledge-runtime/validation/validation.routes.js
 *
 * Mounted at: /api/v1/validation (see server.js — mounted behind the
 * existing `authenticate` middleware, matching the Knowledge/Student/
 * Recommendation runtime precedent).
 *
 * Endpoints:
 *   GET /me — current caller's decision-readiness ValidationResult
 */

const { Router } = require('express');
const validationController = require('./validation.controller');

const router = Router();

router.get('/me', validationController.getMyValidation);

module.exports = Object.freeze(router);
