'use strict';

const crypto = require('crypto');
const observabilityRepo = require('../../repositories/ai-observability.repository');
const OBSERVABILITY_CONFIG = require('../../config/observability.config');
const alertService = require('../observability/alert.service');

/**
 * drift.service.js (ENHANCED — replaces V1)
 *
 * Segmented Drift Detection Engine.
 *
 * V1 tracked drift globally per feature.
 * V2 adds SEGMENT-AWARE baseline tracking.
 *
 * SEGMENT DIMENSIONS:
 *   - role_family      (e.g., 'engineering', 'design', 'product')
 *   - industry         (e.g., 'fintech', 'healthcare', 'saas')
 *   - geography        (e.g., 'US', 'IN', 'EU')
 *   - experience_level (e.g., 'junior', 'mid', 'senior', 'exec')
 *
 * SEGMENT KEY DESIGN:
 *   baselineKey = `${feature}::${segmentHash}`
 *   segmentHash = SHA-256(sorted segment fields)[:12]
 *
 *   This ensures:
 *   - Consistent key regardless of field order
 *   - No PII stored (hash only)
 *   - ~16^12 = 281 trillion possible keys (no collision risk)
 *
 * CARDINALITY CONTROL:
 *   With 4 segment dimensions × ~5 values each = ~625 segment combinations.
 *   At 4 features, max ~2,500 unique baseline keys. Manageable in Firestore.
 *   Mitigation: segmentHash is bucketed — unknown values normalize to 'other'.
 *
 * SAMPLING STRATEGY:
 *   Global drift check: 20% of calls (V1 unchanged)
 *   Segmented drift check: 10% of calls (additional 10% overhead at most)
 *   Cost: ~0.3 additional Firestore reads per call on average.
 *
 * PII SAFETY:
 *   Segment metadata is normalized to enum values before hashing.
 *   Raw user data (job title text, location string) is NEVER stored.
 *   Only the hash is stored as baselineKey.
 */

// Normalize segment values to prevent cardinality explosion and PII leakage
const SEGMENT_NORMALIZERS = {
  role_family: (v) => {
    const map = { eng: 'engineering', dev: 'engineering', swe: 'engineering',
                  design: 'design', ux: 'design', pm: 'product', product: 'product',
                  data: 'data', ml: 'data', analyst: 'data', marketing: 'marketing',
                  sales: 'sales', finance: 'finance', legal: 'legal', ops: 'operations' };
    const lower = (v || '').toLowerCase().trim();
    for (const [key, val] of Object.entries(map)) {
      if (lower.includes(key)) return val;
    }
    return 'other';
  },
  industry: (v) => {
    const map = { tech: 'tech', software: 'tech', fintech: 'fintech', finance: 'fintech',
                  health: 'healthcare', medical: 'healthcare', saas: 'saas',
                  ecommerce: 'ecommerce', retail: 'ecommerce', education: 'education',
                  gov: 'government', government: 'government' };
    const lower = (v || '').toLowerCase().trim();
    for (const [key, val] of Object.entries(map)) {
      if (lower.includes(key)) return val;
    }
    return 'other';
  },
  geography: (v) => {
    const known = new Set(['US', 'CA', 'GB', 'IN', 'AU', 'DE', 'FR', 'SG', 'JP', 'BR']);
    const upper = (v || '').toUpperCase().trim().slice(0, 2);
    return known.has(upper) ? upper : 'OTHER';
  },
  experience_level: (v) => {
    const n = parseInt(v);
    if (!isNaN(n)) {
      if (n <= 2) return 'junior';
      if (n <= 5) return 'mid';
      if (n <= 10) return 'senior';
      return 'exec';
    }
    const lower = (v || '').toLowerCase();
    if (lower.includes('junior') || lower.includes('entry')) return 'junior';
    if (lower.includes('mid') || lower.includes('intermediate')) return 'mid';
    if (lower.includes('senior') || lower.includes('lead')) return 'senior';
    if (lower.includes('exec') || lower.includes('director') || lower.includes('vp')) return 'exec';
    return 'mid';
  },
};

class DriftService {
  /**
   * Observe a new AI output and check for both global and segmented drift.
   *
   * @param {Object} params
   * @param {string} params.feature
   * @param {string} params.userId
   * @param {string} params.model
   * @param {number} [params.score]
   * @param {number} [params.salaryMedian]
   * @param {number} [params.confidenceScore]
   * @param {Object} [params.segment] - { role_family, industry, geography, experience_level }
   * @param {string} [params.correlationId]
   */
  async observe(params) {
    const { feature, userId, model, score, salaryMedian, confidenceScore, segment = {}, correlationId } = params;

    if (!OBSERVABILITY_CONFIG.drift.features.includes(feature)) return;

    const normalizedSegment = this._normalizeSegment(segment);
    const segmentHash = this._hashSegment(normalizedSegment);

    const observation = {
      feature,
      userId: userId || 'anonymous',
      model: model || 'unknown',
      score: score != null ? Number(score) : null,
      salaryMedian: salaryMedian != null ? Number(salaryMedian) : null,
      confidenceScore: confidenceScore != null ? Number(confidenceScore) : null,
      segmentHash,
      // Store normalized segment labels (not raw PII) for analytical grouping
      segmentLabels: normalizedSegment,
      correlationId: correlationId || null,
    };

    observabilityRepo.writeDriftSnapshot(observation).catch(() => {});

    // Global drift (20% sample)
    if (Math.random() < 0.20) {
      this._evaluateDrift(feature, observation, null).catch(() => {});
    }

    // Segmented drift (10% sample, only if segment data provided)
    if (segmentHash && Math.random() < 0.10) {
      this._evaluateDrift(feature, observation, segmentHash).catch(() => {});
    }
  }

  /**
   * Evaluate drift against baseline. segmentHash=null means global baseline.
   */
  async _evaluateDrift(feature, current, segmentHash) {
    const history = await observabilityRepo.getDriftHistory(feature,
      OBSERVABILITY_CONFIG.drift.baselineWindowDays,
      segmentHash // null = global, string = segmented
    );

    const minSamples = segmentHash
      ? Math.floor(OBSERVABILITY_CONFIG.drift.minSamplesForBaseline / 3) // lower threshold for segments
      : OBSERVABILITY_CONFIG.drift.minSamplesForBaseline;

    if (history.length < minSamples) return;

    const alerts = [];
    const scope = segmentHash ? `segment:${segmentHash.slice(0, 8)}` : 'global';

    for (const [metric, threshold, field] of [
      ['score', OBSERVABILITY_CONFIG.drift.scoreDeviationThreshold, 'score'],
      ['salaryMedian', OBSERVABILITY_CONFIG.drift.salaryDeviationThreshold, 'salaryMedian'],
      ['confidenceScore', OBSERVABILITY_CONFIG.drift.confidenceDeviationThreshold, 'confidenceScore'],
    ]) {
      if (current[field] == null) continue;
      const baseline = this._rollingAverage(history, field);
      if (baseline == null || baseline === 0) continue;

      const deviation = Math.abs(current[field] - baseline) / Math.abs(baseline);
      if (deviation > threshold) {
        alerts.push({
          metric, scope,
          currentValue: current[field],
          baselineValue: baseline,
          deviationPct: +(deviation * 100).toFixed(2),
          threshold: +(threshold * 100),
          severity: deviation > threshold * 1.67 ? 'CRITICAL' : 'WARNING',
          segmentLabels: segmentHash ? current.segmentLabels : null,
        });
      }
    }

    for (const driftAlert of alerts) {
      await alertService.fire({
        type: 'DRIFT',
        feature,
        severity: driftAlert.severity,
        title: `Drift [${scope}]: ${feature} → ${driftAlert.metric} (${driftAlert.deviationPct}% deviation)`,
        detail: driftAlert,
        model: current.model,
        correlationId: current.correlationId,
      }).catch(() => {});
    }
  }

  /**
   * Advanced statistical drift report using z-score and variance tracking.
   */
  async getDriftReport({ feature, days = 30, segment = null } = {}) {
    const features = feature ? [feature] : OBSERVABILITY_CONFIG.drift.features;
    const report = {};

    for (const f of features) {
      const segmentHash = segment ? this._hashSegment(this._normalizeSegment(segment)) : null;
      const history = await observabilityRepo.getDriftHistory(f, days, segmentHash);

      if (history.length === 0) {
        report[f] = { status: 'no_data', sampleCount: 0, scope: segmentHash ? 'segmented' : 'global' };
        continue;
      }

      const scoreValues = history.map(h => h.score).filter(v => v != null);
      const salaryValues = history.map(h => h.salaryMedian).filter(v => v != null);
      const confValues = history.map(h => h.confidenceScore).filter(v => v != null);

      report[f] = {
        sampleCount: history.length,
        scope: segmentHash ? 'segmented' : 'global',
        score: this._computeStats(scoreValues),
        salaryMedian: this._computeStats(salaryValues),
        confidenceScore: this._computeStats(confValues),
        latestObservation: history[0] ? {
          date: history[0].createdAt,
          score: history[0].score,
          salaryMedian: history[0].salaryMedian,
          confidenceScore: history[0].confidenceScore,
          segmentLabels: history[0].segmentLabels,
        } : null,
      };
    }

    return report;
  }

  /**
   * Compute full statistical profile for an array of values.
   * Used for advanced drift analysis (z-score, variance, percentile shift).
   */
  _computeStats(values) {
    if (!values || values.length < 2) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
    const stdDev = Math.sqrt(variance);

    // Z-score of most recent value
    const latest = values[0]; // history is DESC ordered
    const zScore = stdDev > 0 ? (latest - mean) / stdDev : 0;

    return {
      baseline: +mean.toFixed(4),
      stdDev: +stdDev.toFixed(4),
      variance: +variance.toFixed(4),
      latestValue: latest,
      zScore: +zScore.toFixed(3),
      // Z-score > 2 = anomaly (p < 0.05 under normal distribution)
      anomalyFlag: Math.abs(zScore) > 2,
      p25: sorted[Math.floor(sorted.length * 0.25)],
      p75: sorted[Math.floor(sorted.length * 0.75)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
    };
  }

  _normalizeSegment(segment) {
    if (!segment || typeof segment !== 'object') return {};
    const result = {};
    for (const [key, normalizer] of Object.entries(SEGMENT_NORMALIZERS)) {
      if (segment[key] != null) {
        result[key] = normalizer(segment[key]);
      }
    }
    return result;
  }

  _hashSegment(normalizedSegment) {
    if (!normalizedSegment || Object.keys(normalizedSegment).length === 0) return null;
    // Sort keys for deterministic hashing
    const canonical = Object.entries(normalizedSegment)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('|');
    return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  }

  _rollingAverage(records, field) {
    const values = records.map(r => r[field]).filter(v => v != null && !isNaN(v));
    if (values.length === 0) return null;
    return +(values.reduce((s, v) => s + v, 0) / values.length).toFixed(4);
  }
}

module.exports = new DriftService();