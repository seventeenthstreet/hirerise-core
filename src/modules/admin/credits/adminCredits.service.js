'use strict';

/**
 * adminCredits.service.js — Usage / Credits — Admin Business Logic
 *
 * Phase 4 Usage/Credits Contract Lock — Step 6.
 *
 * Thin orchestration layer over adminCredits.repository.js, following the
 * same shape as adminWeights.service.js: read methods return plain data
 * (repository already maps to camelCase), write methods (grant/adjust)
 * translate RPC-surfaced error codes into the existing AppError/ErrorCodes
 * convention this codebase's error handler and route tests expect.
 *
 * No aggregate analytics, no export, no cross-user reporting — a single
 * consolidated read (getUserCreditSummary) intentionally returns balance +
 * quota + first ledger page together (Phase 3 Contract §18 explicitly
 * allows this to keep the API surface minimal), and a dedicated
 * listLedger() covers pagination/filtering beyond the first page.
 */

const { adminCreditsRepository: repo } = require('./adminCredits.repository');
const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');
const logger = require('../../../utils/logger');

function mapMutationError(err, { targetUserId }) {
  const message = String(err?.message || '');

  if (message.includes('DUPLICATE_REFERENCE') || err?.code === '23505') {
    return new AppError(
      'A credit mutation with this reference has already been applied.',
      409,
      { targetUserId },
      ErrorCodes.CONFLICT
    );
  }

  if (message.includes('USER_NOT_FOUND') || err?.code === 'P0002') {
    return new AppError(
      'Target user not found.',
      404,
      { targetUserId },
      ErrorCodes.NOT_FOUND
    );
  }

  if (message.includes('INSUFFICIENT_CREDITS')) {
    return new AppError(
      'This adjustment would take the balance below zero.',
      409,
      { targetUserId },
      ErrorCodes.CONFLICT
    );
  }

  if (message.includes('UNAUTHORIZED') || err?.code === '42501') {
    // Should be unreachable in normal operation — requireMasterAdmin
    // already gates this route, and actorAdminId is always req.user.id,
    // never attacker-supplied. If this ever fires, it means the RPC's
    // database-layer authorization check (added in the Phase 4B
    // migration correction) caught something the Node layer didn't —
    // worth logging distinctly rather than folding into the generic
    // 500 path.
    logger.error('[AdminCreditsService] RPC rejected actor as non-MASTER_ADMIN', {
      targetUserId,
      error: message,
    });
    return new AppError(
      'Not authorized to perform this action.',
      403,
      { targetUserId },
      ErrorCodes.FORBIDDEN
    );
  }

  if (
    message.includes('INVALID_AMOUNT') ||
    message.includes('REASON_REQUIRED') ||
    message.includes('REFERENCE_REQUIRED') ||
    message.includes('ACTOR_REQUIRED')
  ) {
    return new AppError(message, 400, { targetUserId }, ErrorCodes.VALIDATION_ERROR);
  }

  logger.error('[AdminCreditsService] Unexpected mutation failure', {
    targetUserId,
    error: message,
    code: err?.code,
  });

  return new AppError(
    'Credit mutation failed.',
    500,
    { targetUserId },
    ErrorCodes.INTERNAL_ERROR
  );
}

/**
 * Resolves the target user by ID or email (Phase 3 Contract §20), then
 * returns identity + authoritative balance + both quota systems
 * (kept separate — §21) + the first page of the ledger.
 */
async function getUserCreditSummary(idOrEmail) {
  const user = await repo.findUserByIdOrEmail(idOrEmail);

  if (!user) {
    throw new AppError('User not found.', 404, { idOrEmail }, ErrorCodes.NOT_FOUND);
  }

  const [usageCounter, featureQuota, ledgerPage] = await Promise.all([
    repo.getUsageCounterState(user.id),
    repo.getFeatureQuotaState(user.id),
    repo.listLedger(user.id, { limit: 25, offset: 0 }),
  ]);

  return {
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
    },
    // Authoritative balance (Phase 3 Contract §22) — never derived from
    // the ledger.
    creditBalance: user.aiCreditsRemaining,
    quota: {
      // System A
      usageCounter: {
        monthlyAiUsageCount: usageCounter.monthlyAiUsageCount,
        aiUsageResetDate: usageCounter.aiUsageResetDate,
      },
      // System B
      featureQuota: {
        monthKey: featureQuota.monthKey,
        features: featureQuota.features,
      },
    },
    ledger: ledgerPage,
  };
}

async function listLedger(userId, opts) {
  // Confirm the user exists before paginating a stranger's ledger by a
  // raw id typo — mirrors getUserCreditSummary()'s 404 convention.
  const user = await repo.getUserById(userId);
  if (!user) {
    throw new AppError('User not found.', 404, { userId }, ErrorCodes.NOT_FOUND);
  }
  return repo.listLedger(userId, opts);
}

/**
 * MASTER_ADMIN Grant. Route-level express-validator already checks types/
 * presence; this only maps RPC failures to AppError.
 */
async function grantCredits({ targetUserId, amount, reason, referenceId, actorAdminId }) {
  try {
    const result = await repo.grant({ targetUserId, amount, reason, referenceId, actorAdminId });

    logger.info('[AdminCreditsService] Credits granted', {
      targetUserId,
      amount,
      referenceId,
      actorAdminId,
      balanceAfter: result.balanceAfter,
    });

    return result;
  } catch (err) {
    throw mapMutationError(err, { targetUserId });
  }
}

/**
 * MASTER_ADMIN Adjust.
 */
async function adjustCredits({ targetUserId, adjustment, reason, referenceId, actorAdminId }) {
  try {
    const result = await repo.adjust({ targetUserId, adjustment, reason, referenceId, actorAdminId });

    logger.info('[AdminCreditsService] Credits adjusted', {
      targetUserId,
      adjustment,
      referenceId,
      actorAdminId,
      balanceAfter: result.balanceAfter,
    });

    return result;
  } catch (err) {
    throw mapMutationError(err, { targetUserId });
  }
}

module.exports = {
  getUserCreditSummary,
  listLedger,
  grantCredits,
  adjustCredits,
};
