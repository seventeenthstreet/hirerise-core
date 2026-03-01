'use strict';

const observabilityRepo = require('../../repositories/ai-observability.repository');
const OBSERVABILITY_CONFIG = require('../../config/observability.config');
const alertService = require('./alert.service');

/**
 * CostTracker — AI cost intelligence module.
 *
 * Tracks and aggregates cost per:
 *  - Individual call (real-time token-based calculation)
 *  - Feature per day
 *  - User per day
 *  - Monthly rollup
 *
 * Budget alerts are triggered when monthly totals exceed configured thresholds.
 *
 * Model rate table is in observability.config.js — update rates there.
 */
class CostTracker {
  /**
   * Record cost for a completed AI call.
   * Called by orchestrator after each inference.
   *
   * @param {Object} params
   * @param {string} params.userId
   * @param {string} params.feature
   * @param {string} params.model
   * @param {number} params.tokensInput
   * @param {number} params.tokensOutput
   * @returns {number} cost in USD
   */
  async track(params) {
    const { userId, feature, model, tokensInput = 0, tokensOutput = 0 } = params;

    const cost = this.calculateCost(model, tokensInput, tokensOutput);
    const dateStr = new Date().toISOString().split('T')[0];

    // Upsert per-user/feature/day cost entry
    await observabilityRepo.upsertCostEntry(userId, feature, dateStr, {
      totalCostUSD: cost,
      inputTokens: tokensInput,
      outputTokens: tokensOutput,
    }).catch(err => {
      console.error('[CostTracker] Failed to write cost entry:', err.message);
    });

    // Check budget (sampled: 1 in 20 calls to reduce overhead)
    if (Math.random() < 0.05) {
      this._checkBudgetThresholds(userId, feature).catch(() => {});
    }

    return cost;
  }

  /**
   * Calculate USD cost from token counts.
   * Rates are per 1000 tokens.
   */
  calculateCost(model, tokensInput, tokensOutput) {
    const rates = OBSERVABILITY_CONFIG.modelRates[model]
      || OBSERVABILITY_CONFIG.modelRates['default'];

    const inputCost = (tokensInput / 1000) * rates.input;
    const outputCost = (tokensOutput / 1000) * rates.output;
    return +(inputCost + outputCost).toFixed(6);
  }

  /**
   * Get cost summary for dashboard.
   * Returns breakdown by feature and user for the current month.
   */
  async getMonthlySummary(monthStr) {
    if (!monthStr) {
      const now = new Date();
      monthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }

    const entries = await observabilityRepo.getMonthlyCostSummary(monthStr);

    const byFeature = {};
    const byUser = {};
    let totalCostUSD = 0;
    let totalTokens = 0;

    for (const entry of entries) {
      const cost = entry.totalCostUSD || 0;
      const tokens = (entry.inputTokens || 0) + (entry.outputTokens || 0);
      totalCostUSD += cost;
      totalTokens += tokens;

      // By feature
      if (!byFeature[entry.feature]) {
        byFeature[entry.feature] = { totalCostUSD: 0, totalTokens: 0, callCount: 0 };
      }
      byFeature[entry.feature].totalCostUSD += cost;
      byFeature[entry.feature].totalTokens += tokens;
      byFeature[entry.feature].callCount += entry.callCount || 0;

      // By user (top consumers — aggregate)
      if (entry.userId) {
        if (!byUser[entry.userId]) {
          byUser[entry.userId] = { totalCostUSD: 0, totalTokens: 0 };
        }
        byUser[entry.userId].totalCostUSD += cost;
        byUser[entry.userId].totalTokens += tokens;
      }
    }

    // Round all values
    Object.values(byFeature).forEach(f => {
      f.totalCostUSD = +f.totalCostUSD.toFixed(4);
    });
    Object.values(byUser).forEach(u => {
      u.totalCostUSD = +u.totalCostUSD.toFixed(4);
    });

    // Sort top users by cost
    const topUsers = Object.entries(byUser)
      .sort(([, a], [, b]) => b.totalCostUSD - a.totalCostUSD)
      .slice(0, 20)
      .map(([userId, data]) => ({ userId, ...data }));

    return {
      month: monthStr,
      totalCostUSD: +totalCostUSD.toFixed(4),
      totalTokens,
      byFeature,
      topUsers,
      thresholds: {
        monthlyWarning: OBSERVABILITY_CONFIG.budget.monthlyWarningUSD,
        monthlyCritical: OBSERVABILITY_CONFIG.budget.monthlyCriticalUSD,
        status: this._budgetStatus(totalCostUSD),
      },
    };
  }

  _budgetStatus(costUSD) {
    if (costUSD >= OBSERVABILITY_CONFIG.budget.monthlyCriticalUSD) return 'CRITICAL';
    if (costUSD >= OBSERVABILITY_CONFIG.budget.monthlyWarningUSD) return 'WARNING';
    return 'OK';
  }

  async _checkBudgetThresholds(userId, feature) {
    const now = new Date();
    const monthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const entries = await observabilityRepo.getMonthlyCostSummary(monthStr);

    const totalCost = entries.reduce((s, e) => s + (e.totalCostUSD || 0), 0);

    if (totalCost >= OBSERVABILITY_CONFIG.budget.monthlyCriticalUSD) {
      await alertService.fire({
        type: 'BUDGET',
        feature,
        severity: 'CRITICAL',
        title: 'Monthly AI budget critical threshold breached',
        detail: {
          month: monthStr,
          totalCostUSD: +totalCost.toFixed(2),
          threshold: OBSERVABILITY_CONFIG.budget.monthlyCriticalUSD,
        },
      });
    } else if (totalCost >= OBSERVABILITY_CONFIG.budget.monthlyWarningUSD) {
      await alertService.fire({
        type: 'BUDGET',
        feature,
        severity: 'WARNING',
        title: 'Monthly AI budget warning threshold reached',
        detail: {
          month: monthStr,
          totalCostUSD: +totalCost.toFixed(2),
          threshold: OBSERVABILITY_CONFIG.budget.monthlyWarningUSD,
        },
      });
    }
  }
}

module.exports = new CostTracker();