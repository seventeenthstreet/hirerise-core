'use strict';

const observabilityRepo = require('../../repositories/ai-observability.repository');
const OBSERVABILITY_CONFIG = require('../../config/observability.config');
const alertService = require('./alert.service');
const logger = require('../../utils/logger');

class CostTracker {

  // ─────────────────────────────────────────────
  // TRACK COST
  // ─────────────────────────────────────────────

  async track(params) {
    const {
      userId,
      feature,
      model,
      tokensInput = 0,
      tokensOutput = 0,
    } = params;

    // ✅ validation
    const input = Math.max(0, Number(tokensInput) || 0);
    const output = Math.max(0, Number(tokensOutput) || 0);

    const cost = this.calculateCost(model, input, output);
    const dateStr = new Date().toISOString().split('T')[0];

    // ✅ timeout protection
    await Promise.race([
      observabilityRepo.upsertCostEntry(userId, feature, dateStr, {
        totalCostUSD: cost,
        inputTokens: input,
        outputTokens: output,
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 2000)
      ),
    ]).catch(err => {
      logger.error('[CostTracker] write failed', { error: err.message });
    });

    // ✅ deterministic sampling (5%)
    if (this._shouldSample(userId)) {
      this._checkBudgetThresholds(userId, feature).catch(() => {});
    }

    return cost;
  }

  // ─────────────────────────────────────────────
  // COST CALCULATION
  // ─────────────────────────────────────────────

  calculateCost(model, tokensInput, tokensOutput) {
    const rates =
      OBSERVABILITY_CONFIG.modelRates[model] ||
      OBSERVABILITY_CONFIG.modelRates['default'];

    const inputCost = (tokensInput / 1000) * rates.input;
    const outputCost = (tokensOutput / 1000) * rates.output;

    return +(inputCost + outputCost).toFixed(6);
  }

  // ─────────────────────────────────────────────
  // MONTHLY SUMMARY
  // ─────────────────────────────────────────────

  async getMonthlySummary(monthStr) {
    if (!monthStr) {
      const now = new Date();
      monthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }

    let entries;

    try {
      entries = await observabilityRepo.getMonthlyCostSummary(monthStr);
    } catch (err) {
      logger.error('[CostTracker] summary fetch failed', { error: err.message });
      return { month: monthStr, status: 'error' };
    }

    const byFeature = {};
    const byUser = {};
    let totalCostUSD = 0;
    let totalTokens = 0;

    for (const entry of entries) {
      const cost = entry.totalCostUSD || 0;
      const tokens = (entry.inputTokens || 0) + (entry.outputTokens || 0);

      totalCostUSD += cost;
      totalTokens += tokens;

      if (!byFeature[entry.feature]) {
        byFeature[entry.feature] = {
          totalCostUSD: 0,
          totalTokens: 0,
          callCount: 0,
        };
      }

      byFeature[entry.feature].totalCostUSD += cost;
      byFeature[entry.feature].totalTokens += tokens;
      byFeature[entry.feature].callCount += entry.callCount || 0;

      if (entry.userId) {
        if (!byUser[entry.userId]) {
          byUser[entry.userId] = {
            totalCostUSD: 0,
            totalTokens: 0,
          };
        }

        byUser[entry.userId].totalCostUSD += cost;
        byUser[entry.userId].totalTokens += tokens;
      }
    }

    Object.values(byFeature).forEach(f => {
      f.totalCostUSD = +f.totalCostUSD.toFixed(4);
    });

    Object.values(byUser).forEach(u => {
      u.totalCostUSD = +u.totalCostUSD.toFixed(4);
    });

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

  // ─────────────────────────────────────────────
  // BUDGET CHECK
  // ─────────────────────────────────────────────

  _budgetStatus(costUSD) {
    if (costUSD >= OBSERVABILITY_CONFIG.budget.monthlyCriticalUSD) return 'CRITICAL';
    if (costUSD >= OBSERVABILITY_CONFIG.budget.monthlyWarningUSD) return 'WARNING';
    return 'OK';
  }

  async _checkBudgetThresholds(userId, feature) {
    const now = new Date();
    const monthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    let entries;

    try {
      entries = await observabilityRepo.getMonthlyCostSummary(monthStr);
    } catch (err) {
      logger.error('[CostTracker] budget fetch failed', { error: err.message });
      return;
    }

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
        },
      });
    }
  }

  // ─────────────────────────────────────────────
  // SAMPLING
  // ─────────────────────────────────────────────

  _shouldSample(key = '') {
    let hash = 0;

    for (let i = 0; i < key.length; i++) {
      hash = (hash << 5) - hash + key.charCodeAt(i);
      hash |= 0;
    }

    return Math.abs(hash % 20) === 0; // ~5%
  }
}

module.exports = new CostTracker();