'use strict';

/**
 * adminCredits.controller.js — HTTP handlers for /admin/credits
 *
 * Phase 4 Usage/Credits Contract Lock — Step 6.
 *
 * Response envelope matches the existing HireRise convention (see
 * adminWeights.controller.js / adminUsers.controller.js):
 *   { success: true, data: {...} }
 *   { success: false, error: { code, message } }  (via the global error
 *     handler — errors are thrown, not hand-formatted here)
 *
 * The acting admin's identity for Grant/Adjust comes only from
 * req.user.id (set by `authenticate`) — never from the request body,
 * matching adminWeights.controller.js's approveVersion()/
 * deprecateVersion() convention.
 */

const { asyncHandler } = require('../../../utils/helpers');
const creditsService = require('./adminCredits.service');
const logger = require('../../../utils/logger');

// ── GET /api/v1/admin/credits/user/:idOrEmail ────────────────────────────
const getUserCredits = asyncHandler(async (req, res) => {
  const { idOrEmail } = req.params;

  const summary = await creditsService.getUserCreditSummary(idOrEmail);

  logger.info('[AdminCredits] Viewed user credit summary', {
    adminId: req.user?.id ?? null,
    targetUserId: summary.user.id,
  });

  return res.status(200).json({ success: true, data: summary });
});

// ── GET /api/v1/admin/credits/user/:userId/ledger ────────────────────────
const getLedger = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { limit, offset, transactionType, startDate, endDate } = req.query;

  const ledger = await creditsService.listLedger(userId, {
    limit: limit ? Number(limit) : undefined,
    offset: offset ? Number(offset) : undefined,
    transactionType: transactionType || undefined,
    startDate: startDate || undefined,
    endDate: endDate || undefined,
  });

  return res.status(200).json({ success: true, data: ledger });
});

// ── POST /api/v1/admin/credits/grant ─────────────────────────────────────
const grant = asyncHandler(async (req, res) => {
  const actorAdminId = req.user?.id;
  const { userId, amount, reason, referenceId } = req.body;

  const result = await creditsService.grantCredits({
    targetUserId: userId,
    amount,
    reason,
    referenceId,
    actorAdminId,
  });

  logger.info('[AdminCredits] Grant applied', {
    adminId: actorAdminId ?? null,
    targetUserId: userId,
    amount,
    referenceId,
    balanceAfter: result.balanceAfter,
  });

  return res.status(200).json({
    success: true,
    data: {
      userId,
      amount,
      balanceAfter: result.balanceAfter,
      ledgerId: result.ledgerId,
    },
  });
});

// ── POST /api/v1/admin/credits/adjust ────────────────────────────────────
const adjust = asyncHandler(async (req, res) => {
  const actorAdminId = req.user?.id;
  const { userId, adjustment, reason, referenceId } = req.body;

  const result = await creditsService.adjustCredits({
    targetUserId: userId,
    adjustment,
    reason,
    referenceId,
    actorAdminId,
  });

  logger.info('[AdminCredits] Adjust applied', {
    adminId: actorAdminId ?? null,
    targetUserId: userId,
    adjustment,
    referenceId,
    balanceAfter: result.balanceAfter,
  });

  return res.status(200).json({
    success: true,
    data: {
      userId,
      adjustment,
      balanceAfter: result.balanceAfter,
      ledgerId: result.ledgerId,
    },
  });
});

module.exports = {
  getUserCredits,
  getLedger,
  grant,
  adjust,
};
