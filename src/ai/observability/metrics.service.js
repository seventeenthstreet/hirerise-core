'use strict';

const observabilityRepo = require('../../repositories/ai-observability.repository');
const OBSERVABILITY_CONFIG = require('../../config/observability.config');
const logger = require('../../utils/logger');

class MetricsService {

  async runDailyAggregation(dateStr) {
    const features = OBSERVABILITY_CONFIG.drift.features;
    const results = [];

    for (const feature of features) {
      try {
        const logs = await this._fetchLogsForDate(feature, dateStr);

        if (!logs.length) continue;

        const metrics = this._computeMetrics(logs);

        // ✅ timeout protection
        await Promise.race([
          observabilityRepo.upsertDailyMetrics(feature, dateStr, metrics),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), 3000)
          ),
        ]);

        results.push({
          feature,
          status: 'ok',
          callCount: metrics.callCount,
        });

      } catch (err) {
        logger.error('[MetricsService] Aggregation failed', {
          feature,
          date: dateStr,
          error: err.message,
        });

        results.push({
          feature,
          status: 'error',
          error: err.message,
        });
      }
    }

    return results;
  }

  // ─────────────────────────────
  // OPTIMIZED SINGLE-PASS METRICS
  // ─────────────────────────────

  _computeMetrics(logs) {
    const latencies = [];
    const confidenceScores = [];

    let successCount = 0;
    let errorCount = 0;

    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    const errorBreakdown = {};
    const modelDistribution = {};

    for (const l of logs) {
      // success/error
      if (l.success) successCount++;
      else {
        errorCount++;
        const code = l.errorCode || 'UNKNOWN';
        errorBreakdown[code] = (errorBreakdown[code] || 0) + 1;
      }

      // latency
      if (Number.isFinite(l.latencyMs) && l.latencyMs >= 0) {
        latencies.push(l.latencyMs);
      }

      // tokens
      const inTok = Math.max(0, Number(l.tokensInput) || 0);
      const outTok = Math.max(0, Number(l.tokensOutput) || 0);

      totalInputTokens += inTok;
      totalOutputTokens += outTok;

      // confidence
      if (Number.isFinite(l.confidenceScore)) {
        confidenceScores.push(l.confidenceScore);
      }

      // model
      const m = l.model || 'unknown';
      modelDistribution[m] = (modelDistribution[m] || 0) + 1;
    }

    latencies.sort((a, b) => a - b);

    const total = logs.length;

    return {
      callCount: total,
      successCount,
      errorCount,
      errorRate: total > 0 ? +(errorCount / total).toFixed(4) : 0,

      latencyP50Ms: this._percentile(latencies, 50),
      latencyP95Ms: this._percentile(latencies, 95),
      latencyP99Ms: this._percentile(latencies, 99),
      latencyMinMs: latencies[0] ?? null,
      latencyMaxMs: latencies[latencies.length - 1] ?? null,
      latencyAvgMs: latencies.length ? Math.round(this._average(latencies)) : null,

      avgInputTokens: total ? Math.round(totalInputTokens / total) : 0,
      avgOutputTokens: total ? Math.round(totalOutputTokens / total) : 0,
      avgTotalTokens: total ? Math.round((totalInputTokens + totalOutputTokens) / total) : 0,

      totalInputTokens,
      totalOutputTokens,

      avgConfidenceScore: confidenceScores.length
        ? +this._average(confidenceScores).toFixed(4)
        : null,

      minConfidenceScore: confidenceScores.length
        ? Math.min(...confidenceScores)
        : null,

      errorBreakdown,
      modelDistribution,

      latencyWarningBreaches: latencies.filter(
        l => l > OBSERVABILITY_CONFIG.latency.singleCallWarningMs
      ).length,
    };
  }

  // ─────────────────────────────
  // DATA FETCH
  // ─────────────────────────────

  async _fetchLogsForDate(feature, dateStr) {
    const { supabase } = require('../../config/supabase');

    const limit = OBSERVABILITY_CONFIG.metrics?.fetchLimit || 5000;

    const { data, error } = await supabase
      .from('ai_logs')
      .select('*')
      .eq('feature', feature)
      .eq('date', dateStr)
      .eq('isDeleted', false)
      .limit(limit);

    if (error) {
      throw new Error(`[MetricsService] Failed to fetch logs: ${error.message}`);
    }

    return data || [];
  }

  // ─────────────────────────────
  // DASHBOARD SUMMARY
  // ─────────────────────────────

  async getDashboardSummary({ days = 7 } = {}) {
    const features = OBSERVABILITY_CONFIG.drift.features;
    const summary = {};

    for (const feature of features) {
      try {
        const records = await observabilityRepo.getDailyMetrics(feature, { limit: days });
        summary[feature] = this._rollupMetrics(records);
      } catch (err) {
        logger.error('[MetricsService] Dashboard fetch failed', {
          feature,
          error: err.message,
        });
        summary[feature] = null;
      }
    }

    return summary;
  }

  _rollupMetrics(records) {
    if (!records?.length) return null;

    let totalCalls = 0;
    let totalErrors = 0;
    const latencyP95s = [];
    const avgConfidences = [];

    for (const r of records) {
      totalCalls += r.callCount || 0;
      totalErrors += r.errorCount || 0;

      if (r.latencyP95Ms != null) latencyP95s.push(r.latencyP95Ms);
      if (r.avgConfidenceScore != null) avgConfidences.push(r.avgConfidenceScore);
    }

    return {
      periodDays: records.length,
      totalCalls,
      totalErrors,
      errorRate: totalCalls > 0
        ? +(totalErrors / totalCalls * 100).toFixed(2)
        : 0,

      p95LatencyMs: latencyP95s.length
        ? Math.round(this._average(latencyP95s))
        : null,

      avgConfidenceScore: avgConfidences.length
        ? +this._average(avgConfidences).toFixed(4)
        : null,

      latestDate: records[0]?.date || null,
    };
  }

  // ─────────────────────────────
  // UTIL
  // ─────────────────────────────

  _percentile(arr, p) {
    if (!arr.length) return null;
    const idx = Math.ceil((p / 100) * arr.length) - 1;
    return arr[Math.max(0, Math.min(idx, arr.length - 1))];
  }

  _average(arr) {
    if (!arr.length) return 0;
    return arr.reduce((s, v) => s + v, 0) / arr.length;
  }
}

module.exports = new MetricsService();