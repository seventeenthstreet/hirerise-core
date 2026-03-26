'use strict';

/**
 * paymentActivation.service.js
 *
 * Called after successful payment webhook.
 * Sets user tier, plan, credit allocation, and unlocks report.
 *
 * ARCHITECTURE DECISION:
 *   This is the ONLY place that sets tier="pro" and aiCreditsRemaining.
 *   Frontend NEVER controls this. Webhook calls this after payment verification.
 *   Provider-agnostic: Razorpay and Stripe webhooks both call activateProUser().
 */

const { db }      = require('../../config/supabase');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const logger      = require('../../utils/logger');
const { getCreditsForPlan } = require('../analysis/analysis.constants');

/**
 * activateProUser({ userId, planAmount, subscriptionId, provider })
 *
 * @param {string} userId
 * @param {number} planAmount   - 499 | 699 | 999
 * @param {string} subscriptionId - provider's payment/subscription ID
 * @param {string} provider     - 'razorpay' | 'stripe'
 */
async function activateProUser({ userId, planAmount, subscriptionId, provider }) {
  const credits = getCreditsForPlan(planAmount);

  const ref = db.collection('users').doc(userId);

  await db.runTransaction(async (txn) => {
    const doc = await txn.get(ref);

    if (!doc.exists) {
      throw new AppError('User not found during activation', 404, { userId }, ErrorCodes.NOT_FOUND);
    }

    txn.update(ref, {
      tier:                  'pro',
      planAmount,
      aiCreditsRemaining:    credits,
      reportUnlocked:        true,
      subscriptionId,
      subscriptionProvider:  provider,
      subscriptionStatus:    'active',
      subscriptionStart:     new Date(),
      // V1: one-time plan, no end date
      subscriptionEnd:       null,
      updatedAt:             new Date(),
    });
  });

  logger.info('[PaymentActivation] Pro activated', {
    userId,
    planAmount,
    creditsGranted: credits,
    provider,
    subscriptionId,
  });

  return { userId, planAmount, creditsGranted: credits };
}

/**
 * downgradeUser(userId)
 * Called on refund, chargeback, or manual downgrade.
 * Reverts to free tier. Zeroes out credits.
 */
async function downgradeUser(userId) {
  const ref = db.collection('users').doc(userId);

  await db.runTransaction(async (txn) => {
    const doc = await txn.get(ref);
    if (!doc.exists) return; // idempotent

    txn.update(ref, {
      tier:                 'free',
      planAmount:           null,
      aiCreditsRemaining:   0,
      reportUnlocked:       false,
      subscriptionStatus:   'cancelled',
      subscriptionEnd:      new Date(),
      updatedAt:            new Date(),
    });
  });

  logger.info('[PaymentActivation] User downgraded to free', { userId });
}

module.exports = { activateProUser, downgradeUser };








