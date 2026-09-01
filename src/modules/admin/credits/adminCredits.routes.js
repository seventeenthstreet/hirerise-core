'use strict';

/**
 * adminCredits.routes.js — Usage / Credits — Admin Endpoints
 *
 * Phase 4 Usage/Credits Contract Lock — Step 6.
 *
 * Mounted in server.js as:
 *   app.use(
 *     `${API_PREFIX}/admin/credits`,
 *     authenticate,
 *     requireAdmin,
 *     requireElevatedSession,
 *     require('./modules/admin/credits/adminCredits.routes')
 *   );
 *
 * Identical mount-level chain to /admin/users, /admin/weights,
 * /admin/administrators. Grant/Adjust additionally require
 * requireMasterAdmin at the route level, exactly mirroring
 * administrators.routes.js's /grant and adminWeights.routes.js's
 * create/approve/deprecate — the established pattern for "read = ADMIN,
 * mutate = MASTER_ADMIN" in this codebase.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ Method │ Path                              │ Authorization           │
 * ├──────────────────────────────────────────────────────────────────────┤
 * │ GET    │ /admin/credits/user/:idOrEmail     │ requireAdmin           │
 * │ GET    │ /admin/credits/user/:userId/ledger │ requireAdmin           │
 * │ POST   │ /admin/credits/grant               │ requireMasterAdmin     │
 * │ POST   │ /admin/credits/adjust              │ requireMasterAdmin     │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * Deferred (explicitly out of scope per Phase 3 Contract §32): Admin
 * Deduct, Admin Refund, quota editing, export, aggregate analytics. Not
 * implemented anywhere in this module.
 */

const express = require('express');
const { param, query, body } = require('express-validator');
const { validate } = require('../../../middleware/requestValidator');
const { requireMasterAdmin } = require('../../../middleware/requireMasterAdmin.middleware');
const { LEDGER_TRANSACTION_TYPES } = require('./adminCredits.repository');
const ctrl = require('./adminCredits.controller');

const router = express.Router();

// ── GET /admin/credits/user/:idOrEmail ───────────────────────────────────
router.get(
  '/user/:idOrEmail',
  validate([
    param('idOrEmail').isString().trim().isLength({ min: 1, max: 320 }),
  ]),
  ctrl.getUserCredits
);

// ── GET /admin/credits/user/:userId/ledger ───────────────────────────────
router.get(
  '/user/:userId/ledger',
  validate([
    param('userId').isString().trim().notEmpty(),
    query('limit').optional().isInt({ min: 1, max: 200 }).withMessage('limit must be 1-200'),
    query('offset').optional().isInt({ min: 0 }).withMessage('offset must be >= 0'),
    query('transactionType')
      .optional()
      .isIn(LEDGER_TRANSACTION_TYPES)
      .withMessage(`transactionType must be one of: ${LEDGER_TRANSACTION_TYPES.join(', ')}`),
    query('startDate').optional().isISO8601().withMessage('startDate must be an ISO 8601 date'),
    query('endDate').optional().isISO8601().withMessage('endDate must be an ISO 8601 date'),
  ]),
  ctrl.getLedger
);

// ── POST /admin/credits/grant ─────────────────────────────────────────────
// MASTER_ADMIN only (Phase 3 Contract §12/§24). Reason and referenceId are
// both required — referenceId doubles as the idempotency key (§13).
router.post(
  '/grant',
  requireMasterAdmin,
  validate([
    body('userId').isString().trim().notEmpty().withMessage('userId is required'),
    body('amount').isInt({ min: 1 }).withMessage('amount must be a positive integer'),
    body('reason').isString().trim().isLength({ min: 1, max: 1000 }).withMessage('reason is required'),
    body('referenceId').isString().trim().isLength({ min: 1, max: 200 }).withMessage('referenceId is required'),
  ]),
  ctrl.grant
);

// ── POST /admin/credits/adjust ────────────────────────────────────────────
// MASTER_ADMIN only (Phase 3 Contract §14/§25). adjustment may be positive
// or negative but not zero; negative-balance protection is enforced by the
// admin_adjust_credits RPC itself.
router.post(
  '/adjust',
  requireMasterAdmin,
  validate([
    body('userId').isString().trim().notEmpty().withMessage('userId is required'),
    body('adjustment')
      .isInt().withMessage('adjustment must be an integer')
      .custom((value) => Number(value) !== 0).withMessage('adjustment must not be zero'),
    body('reason').isString().trim().isLength({ min: 1, max: 1000 }).withMessage('reason is required'),
    body('referenceId').isString().trim().isLength({ min: 1, max: 200 }).withMessage('referenceId is required'),
  ]),
  ctrl.adjust
);

module.exports = router;
