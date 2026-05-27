'use strict';

/**
 * @file src/modules/ai-event-bus/routes/aiEventBus.routes.js
 *
 * CONTRACT NOTE (Phase 2 Hardening — Risk 3: Local Helper Drift):
 *   Removed local `ok` and `bad` helper factories.
 *   Migrated to shared sendSuccess / sendError from src/shared/response.
 *
 *   BEFORE (Risk 3 violation):
 *     const ok  = (res, data, code = 200) => res.status(code).json({ success: true, data });
 *     const bad = (res, msg, code = 400) => res.status(code).json({ success: false, error: msg });
 *
 *     Problems:
 *       - bad() sent `error` as a string, not the V2 { code, message } object
 *       - ok() had no `meta` envelope
 *       - two independent implementations diverging from the canonical helpers
 *
 *   AFTER: sendSuccess / sendError used throughout for consistent V2 shape.
 *
 *   NOTE: The `bad()` function's `error: msg` (a string) is now automatically
 *   wrapped in the V2 { code, message } shape by sendError. Callers that
 *   read body.error as a string will need to be updated to body.error.message.
 *   Legacy top-level `message` field is preserved for backward compat.
 */

const { Router } = require('express');
const bus = require('./bus/aiEventBus');
const resultsSvc = require('./results/intelligenceResults.service');
const logger = require('../../../utils/logger');
const { sendSuccess, sendError } = require('../../../shared/response');

const router = Router();

// CONTRACT NOTE: Removed local `ok` and `bad` helpers.
// Use sendSuccess / sendError from shared/response for all application routes.
// See docs/api-contract-exemptions.md for exemption rules.

const getUserId = (req) => req.user?.uid || req.user?.id || null;

function asyncHandler(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      logger.error('[EventBusRoute] Unhandled route error', {
        path: req.path,
        error: error.message,
      });
      sendError(res, 500, 'Internal server error', 'INTERNAL_ERROR');
    }
  };
}

module.exports = router;