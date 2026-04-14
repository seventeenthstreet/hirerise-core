'use strict';

const observabilityRepo = require('../../repositories/ai-observability.repository');
const OBSERVABILITY_CONFIG = require('../../config/observability.config');
const logger = require('../../utils/logger');

const dashboardSummaryInflight = new Map();
const dashboardSummaryMicroCache = new Map();
const DASHBOARD_SUMMARY_TTL_MS = 30000;

class MetricsService {
  async runDailyAggregation(dateStr) {
    const features = OBSERVABILITY_CONFIG.drift.features;

    const results = await Promise.allSettled(
      features.map(async (feature) => {
        try {
          const logs = await this._fetchLogsForDate(feature, dateStr);

          if (!logs.length) {
            return {
              feature,
              status: 'skipped',
              callCount: 0,
            };
          }

          const metrics = this._computeMetrics(logs);

          await Promise.race([
            observabilityRepo.upsertDailyMetrics(feature, dateStr, metrics),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('timeout')), 3000)
            ),
          ]);

          return {
            feature,
            status: 'ok',
            callCount: metrics.callCount,
          };
        } catch (err) {
          logger.error('[MetricsService] Aggregation failed', {
            feature,
            date: dateStr,
            error: err.message,
          });

          return {
            feature,
            status: 'error',
            error: err.message,
          };
        }
      })
    );

    return results.map((r) =>
      r.status === 'fulfilled'
        ? r.value
        : {
            status: 'error',
            error: r.reason?.message || 'unknown',
          }
    );
  }

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
      if (l.success) successCount++;
      else {
        errorCount++;
        const code = l.errorCode || 'UNKNOWN';
        errorBreakdown[code] = (errorBreakdown[code] || 0) + 1;
      }

      if (Number.isFinite(l.latencyMs) && l.latencyMs >= 0) {
        latencies.push(l.latencyMs);
      }

      totalInputTokens += Math.max(0, Number(l.tokensInput) || 0);
      totalOutputTokens += Math.max(0, Number(l.tokensOutput) || 0);

      if (Number.isFinite(l.confidenceScore)) {
        confidenceScores.push(l.confidenceScore);
      }

      const model = l.model || 'unknown';
      modelDistribution[model] = (modelDistribution[model] || 0) + 1;
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
      latencyAvgMs: latencies.length
        ? Math.round(this._average(latencies))
        : null,
      avgInputTokens: total
        ? Math.round(totalInputTokens / total)
        : 0,
      avgOutputTokens: total
        ? Math.round(totalOutputTokens / total)
        : 0,
      avgTotalTokens: total
        ? Math.round((totalInputTokens + totalOutputTokens) / total)
        : 0,
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
        (l) => l > OBSERVABILITY_CONFIG.latency.singleCallWarningMs
      ).length,
    };
  }

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

  async getDashboardSummary({ days = 7 } = {}) {
    const cacheKey = `dashboard-summary:${days}`;
    const cached = dashboardSummaryMicroCache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    if (dashboardSummaryInflight.has(cacheKey)) {
      return dashboardSummaryInflight.get(cacheKey);
    }

    const features = OBSERVABILITY_CONFIG.drift.features;

    const summaryPromise = (async () => {
      const entries = await Promise.all(
        features.map(async (feature) => {
          try {
            const records =
              await observabilityRepo.getDailyMetrics(feature, {
                limit: days,
              });

            return [feature, this._rollupMetrics(records)];
          } catch (err) {
            logger.error('[MetricsService] Dashboard fetch failed', {
              feature,
              error: err.message,
            });

            return [feature, null];
          }
        })
      );

      const summary = Object.fromEntries(entries);

      dashboardSummaryMicroCache.set(cacheKey, {
        value: summary,
        expiresAt: Date.now() + DASHBOARD_SUMMARY_TTL_MS,
      });

      return summary;
    })();

    dashboardSummaryInflight.set(cacheKey, summaryPromise);

    try {
      return await summaryPromise;
    } finally {
      dashboardSummaryInflight.delete(cacheKey);
    }
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
      if (r.avgConfidenceScore != null) {
        avgConfidences.push(r.avgConfidenceScore);
      }
    }

    return {
      periodDays: records.length,
      totalCalls,
      totalErrors,
      errorRate:
        totalCalls > 0
          ? +((totalErrors / totalCalls) * 100).toFixed(2)
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