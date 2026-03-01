'use strict';

/**
 * logUsageToFirestore.js
 * Converted from logUsageToFirestore.ts
 *
 * Fire-and-forget usage logger for Claude calls.
 * NEVER blocks response. NEVER throws upstream.
 */

const { usageLogsRepository } = require('./usageLogs.repository');
const { calculateCostUSD }    = require('../../config/pricing.config');

const INR_TO_USD = 0.012;

const EXPECTED_CALLS_PER_PLAN = {
  499: 20,
  699: 30,
  999: 50,
};

/**
 * logUsageToFirestore — Non-blocking usage logger. Safe to call without await.
 */
async function logUsageToFirestore({ userId, feature, tier, model, inputTokens, outputTokens, planAmount }) {
  try {
    if (!userId || !model) return;

    const safeInputTokens  = Number(inputTokens)  || 0;
    const safeOutputTokens = Number(outputTokens) || 0;

    const costUSD = calculateCostUSD(model, safeInputTokens, safeOutputTokens);

    let revenueUSD = 0;
    if (tier !== 'free' && planAmount && planAmount > 0) {
      const expectedCalls = EXPECTED_CALLS_PER_PLAN[planAmount] ?? 30;
      revenueUSD = parseFloat(((planAmount * INR_TO_USD) / expectedCalls).toFixed(8));
    }

    usageLogsRepository.logUsage({
      userId, feature, tier, model,
      inputTokens: safeInputTokens,
      outputTokens: safeOutputTokens,
      costUSD,
      revenueUSD,
    }).catch(() => { /* swallow */ });

  } catch (err) {
    console.error('[logUsageToFirestore] Silent failure:', err?.message);
  }
}

module.exports = { logUsageToFirestore };