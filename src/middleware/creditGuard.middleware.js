'use strict';

const { db }         = require('../config/firebase');
const { AppError, ErrorCodes } = require('./errorHandler');
const { CREDIT_COSTS, isValidOperation } = require('../modules/analysis/analysis.constants');
const { normalizeTier } = require('./requireTier.middleware');

function creditGuard(operationType) {
  return async function (req, res, next) {
    try {
      const userId = req.user?.uid;
      if (!userId) {
        return next(new AppError('Unauthorized', 401, {}, ErrorCodes.UNAUTHORIZED));
      }

      if (!isValidOperation(operationType)) {
        return next(new AppError(`Unknown operation: ${operationType}`, 400, {}, ErrorCodes.VALIDATION_ERROR));
      }

      // Tier from Firebase custom claim — never from Firestore
      const tier = req.user.normalizedTier ?? normalizeTier(req.user.plan);

      // Free users bypass credit check entirely — they never use credits
      if (tier === 'free') return next();

      // Credit balance is operational state (not auth) — reading from Firestore is correct here
      const doc = await db.collection('users').doc(userId).get();
      if (!doc.exists) {
        return next(new AppError('User not found', 404, {}, ErrorCodes.NOT_FOUND));
      }

      const required  = CREDIT_COSTS[operationType];
      const available = doc.data().aiCreditsRemaining ?? 0;

      if (available < required) {
        return next(new AppError(
          'Insufficient AI credits. Please purchase a new plan to continue.',
          402,
          { creditsRequired: required, creditsAvailable: available, operationType },
          ErrorCodes.PAYMENT_REQUIRED
        ));
      }

      req.creditCost       = required;
      req.creditsAvailable = available;

      return next();

    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { creditGuard };