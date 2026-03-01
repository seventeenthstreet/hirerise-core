'use strict';

/**
 * logUsageToFirestore.ts
 *
 * Fire-and-forget usage logger for Claude calls.
 * NEVER blocks response.
 * NEVER throws upstream.
 */

import { usageLogsRepository } from './usageLogs.repository';
import { calculateCostUSD } from '../../config/pricing.config';
import type { UserTier } from '../../types/metrics.types';

const INR_TO_USD = 0.012;

// Expected calls per subscription plan (INR)
const EXPECTED_CALLS_PER_PLAN: Record<number, number> = {
  499: 20,
  699: 30,
  999: 50,
};

interface LogUsageParams {
  userId: string;
  feature: string;
  tier: UserTier;
  model: string;
  inputTokens: number;
  outputTokens: number;
  planAmount?: number; // INR
}

/**
 * logUsageToFirestore
 *
 * Non-blocking usage logger.
 * Safe to call without await.
 */
export async function logUsageToFirestore(
  params: LogUsageParams
): Promise<void> {
  try {
    const {
      userId,
      feature,
      tier,
      model,
      inputTokens,
      outputTokens,
      planAmount,
    } = params;

    // Validate minimum required values
    if (!userId || !model) {
      return;
    }

    const safeInputTokens = Number(inputTokens) || 0;
    const safeOutputTokens = Number(outputTokens) || 0;

    // Calculate cost
    const costUSD = calculateCostUSD(
      model,
      safeInputTokens,
      safeOutputTokens
    );

    // Revenue attribution (amortized)
    let revenueUSD = 0;

    if (tier !== 'free' && planAmount && planAmount > 0) {
      const expectedCalls =
        EXPECTED_CALLS_PER_PLAN[planAmount] ?? 30;

      revenueUSD = parseFloat(
        ((planAmount * INR_TO_USD) / expectedCalls).toFixed(8)
      );
    }

    // Fire-and-forget (do not block main request)
    usageLogsRepository
      .logUsage({
        userId,
        feature,
        tier,
        model,
        inputTokens: safeInputTokens,
        outputTokens: safeOutputTokens,
        costUSD,
        revenueUSD,
      })
      .catch(() => {
        /* swallow */
      });
  } catch (err: any) {
    console.error(
      '[logUsageToFirestore] Silent failure:',
      err?.message
    );
  }
}