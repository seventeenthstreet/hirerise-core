'use strict';

const observabilityRepo = require('../../repositories/ai-observability.repository');
const OBSERVABILITY_CONFIG = require('../../config/observability.config');

/**
 * MetricsService — AI metrics aggregation engine.
 *
 * Responsibilities:
 *  - Daily aggregation of raw ai_logs → ai_metrics_daily
 *  - p95 latency calculation
 *  - Error rate computation
 *  - Token average computation
 *  - Real-time summary for dashboard
 *
 * Called by:
 *  - DailyAggregationWorker (cron)
 *  - Admin dashboard API
 */
class MetricsService {
  /**
   * Run the full daily aggregation job for a given date.
   * Called by cron worker at ~1am UTC for previous day.
   *
   * @param {string} dateStr - 'YYYY-MM-DD'
   */
  async runDailyAggregation(dateStr) {
    const features = OBSERVABILITY_CONFIG.drift.features;
    const results = [];

    for (const feature of features) {
      try {
        const logs = await this._fetchLogsForDate(feature, dateStr);
        if (logs.length === 0) continue;

        const metrics = this._computeMetrics(logs);
        await observabilityRepo.upsertDailyMetrics(feature, dateStr, metrics);
        results.push({ feature, status: 'ok', callCount: metrics.callCount });
      } catch (err) {
        console.error(`[MetricsService] Aggregation failed for ${feature} on ${dateStr}:`, err.message);
        results.push({ feature, status: 'error', error: err.message });
      }
    }

    return results;
  }

  /**
   * Compute all metrics from a set of raw log entries.
   * @param {Array} logs
   * @returns {Object} metrics payload
   */
  _computeMetrics(logs) {
    const total = logs.length;
    const successes = logs.filter(l => l.success);
    const failures = logs.filter(l => !l.success);

    const latencies = logs
      .map(l => l.latencyMs)
      .filter(v => v != null && v >= 0)
      .sort((a, b) => a - b);

    const tokenTotals = logs.map(l => l.totalTokens || 0);
    const inputTokens = logs.map(l => l.tokensInput || 0);
    const outputTokens = logs.map(l => l.tokensOutput || 0);

    const confidenceScores = logs
      .map(l => l.confidenceScore)
      .filter(v => v != null);

    // Error codes breakdown
    const errorBreakdown = {};
    failures.forEach(l => {
      const code = l.errorCode || 'UNKNOWN';
      errorBreakdown[code] = (errorBreakdown[code] || 0) + 1;
    });

    // Model distribution
    const modelDistribution = {};
    logs.forEach(l => {
      const m = l.model || 'unknown';
      modelDistribution[m] = (modelDistribution[m] || 0) + 1;
    });

    return {
      callCount: total,
      successCount: successes.length,
      errorCount: failures.length,
      errorRate: total > 0 ? +(failures.length / total).toFixed(4) : 0,

      // Latency
      latencyP50Ms: this._percentile(latencies, 50),
      latencyP95Ms: this._percentile(latencies, 95),
      latencyP99Ms: this._percentile(latencies, 99),
      latencyMinMs: latencies.length > 0 ? latencies[0] : null,
      latencyMaxMs: latencies.length > 0 ? latencies[latencies.length - 1] : null,
      latencyAvgMs: latencies.length > 0 ? Math.round(this._average(latencies)) : null,

      // Tokens
      avgInputTokens: Math.round(this._average(inputTokens)),
      avgOutputTokens: Math.round(this._average(outputTokens)),
      avgTotalTokens: Math.round(this._average(tokenTotals)),
      totalInputTokens: inputTokens.reduce((s, v) => s + v, 0),
      totalOutputTokens: outputTokens.reduce((s, v) => s + v, 0),

      // Confidence
      avgConfidenceScore: confidenceScores.length > 0
        ? +this._average(confidenceScores).toFixed(4)
        : null,
      minConfidenceScore: confidenceScores.length > 0 ? Math.min(...confidenceScores) : null,

      // Breakdowns
      errorBreakdown,
      modelDistribution,

      // Latency threshold breaches
      latencyWarningBreaches: latencies.filter(
        l => l > OBSERVABILITY_CONFIG.latency.singleCallWarningMs
      ).length,
    };
  }

  /**
   * Fetch raw logs for a specific feature and date.
   * Note: Firestore does not allow range queries on two fields without composite index.
   * We filter by feature and pull all logs for the day (date field is indexed).
   */
  async _fetchLogsForDate(feature, dateStr) {
    // ai_logs has a 'date' string field (YYYY-MM-DD) for efficient daily partitioning
    const db = require('firebase-admin/firestore').getFirestore();
    const snap = await db.collection('ai_logs')
      .where('feature', '==', feature)
      .where('date', '==', dateStr)
      .where('isDeleted', '==', false)
      .limit(5000) // safety cap; tune upward for high-volume features
      .get();
    return snap.docs.map(d => d.data());
  }

  /**
   * Real-time summary for dashboard (last N days of pre-aggregated metrics).
   */
  async getDashboardSummary({ days = 7 } = {}) {
    const features = OBSERVABILITY_CONFIG.drift.features;
    const summary = {};

    for (const feature of features) {
      const records = await observabilityRepo.getDailyMetrics(feature, { limit: days });
      summary[feature] = this._rollupMetrics(records);
    }

    return summary;
  }

  _rollupMetrics(records) {
    if (!records || records.length === 0) return null;

    const totalCalls = records.reduce((s, r) => s + (r.callCount || 0), 0);
    const totalErrors = records.reduce((s, r) => s + (r.errorCount || 0), 0);
    const latencyP95s = records.map(r => r.latencyP95Ms).filter(v => v != null);
    const avgConfidences = records.map(r => r.avgConfidenceScore).filter(v => v != null);

    return {
      periodDays: records.length,
      totalCalls,
      totalErrors,
      errorRate: totalCalls > 0 ? +((totalErrors / totalCalls) * 100).toFixed(2) : 0,
      p95LatencyMs: latencyP95s.length > 0 ? Math.round(this._average(latencyP95s)) : null,
      avgConfidenceScore: avgConfidences.length > 0
        ? +this._average(avgConfidences).toFixed(4)
        : null,
      latestDate: records[0]?.date || null,
    };
  }

  // ─── Math Utilities ──────────────────────────────────────────────────────────

  _percentile(sortedArr, p) {
    if (!sortedArr || sortedArr.length === 0) return null;
    const idx = Math.ceil((p / 100) * sortedArr.length) - 1;
    return sortedArr[Math.max(0, Math.min(idx, sortedArr.length - 1))];
  }

  _average(arr) {
    if (!arr || arr.length === 0) return 0;
    return arr.reduce((s, v) => s + v, 0) / arr.length;
  }
}

module.exports = new MetricsService();