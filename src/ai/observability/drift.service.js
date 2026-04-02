'use strict';

const crypto = require('crypto');
const observabilityRepo = require('../../repositories/ai-observability.repository');
const OBSERVABILITY_CONFIG = require('../../config/observability.config');
const alertService = require('../observability/alert.service');
const logger = require('../../utils/logger');

class DriftService {

  async observe(params) {
    const {
      feature,
      userId,
      model,
      score,
      salaryMedian,
      confidenceScore,
      segment = {},
      correlationId,
    } = params;

    if (!OBSERVABILITY_CONFIG.drift.features.includes(feature)) return;

    const normalizedSegment = this._normalizeSegment(segment);
    const segmentHash = this._hashSegment(normalizedSegment);

    const observation = {
      feature,
      user_id: userId || 'anonymous',
      model: model || 'unknown',
      score: this._safeNumber(score),
      salaryMedian: this._safeNumber(salaryMedian),
      confidenceScore: this._safeNumber(confidenceScore),
      segmentHash,
      segmentLabels: normalizedSegment,
      correlationId: correlationId || null,
    };

    // fire-and-forget write with logging
    observabilityRepo.writeDriftSnapshot(observation)
      .catch(err => logger.warn('[Drift] write failed', { error: err.message }));

    // ✅ deterministic sampling
    if (this._shouldSample(feature, 5)) {
      this._evaluateDrift(feature, observation, null).catch(() => {});
    }

    if (segmentHash && this._shouldSample(segmentHash, 10)) {
      this._evaluateDrift(feature, observation, segmentHash).catch(() => {});
    }
  }

  async _evaluateDrift(feature, current, segmentHash) {
    let history;

    try {
      history = await Promise.race([
        observabilityRepo.getDriftHistory(
          feature,
          OBSERVABILITY_CONFIG.drift.baselineWindowDays,
          segmentHash
        ),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 2000)
        ),
      ]);
    } catch (err) {
      logger.warn('[Drift] history fetch failed', { error: err.message });
      return;
    }

    const minSamples = segmentHash
      ? Math.floor(OBSERVABILITY_CONFIG.drift.minSamplesForBaseline / 3)
      : OBSERVABILITY_CONFIG.drift.minSamplesForBaseline;

    if (!history || history.length < minSamples) return;

    const alerts = [];
    const scope = segmentHash ? `segment:${segmentHash.slice(0, 8)}` : 'global';

    for (const [metric, threshold, field] of [
      ['score', OBSERVABILITY_CONFIG.drift.scoreDeviationThreshold, 'score'],
      ['salaryMedian', OBSERVABILITY_CONFIG.drift.salaryDeviationThreshold, 'salaryMedian'],
      ['confidenceScore', OBSERVABILITY_CONFIG.drift.confidenceDeviationThreshold, 'confidenceScore'],
    ]) {
      if (current[field] == null) continue;

      const baseline = this._rollingAverage(history, field);
      if (!baseline) continue;

      const deviation = Math.abs(current[field] - baseline) / Math.abs(baseline);

      if (deviation > threshold) {
        alerts.push({
          metric,
          scope,
          currentValue: current[field],
          baselineValue: baseline,
          deviationPct: +(deviation * 100).toFixed(2),
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
        title: `Drift [${scope}]: ${feature} → ${driftAlert.metric}`,
        detail: driftAlert,
        model: current.model,
        correlationId: current.correlationId,
      }).catch(() => {});
    }
  }

  async getDriftReport({ feature, days = 30, segment = null } = {}) {
    const features = feature
      ? [feature]
      : OBSERVABILITY_CONFIG.drift.features;

    const report = {};

    for (const f of features) {
      let history;

      try {
        const segmentHash = segment
          ? this._hashSegment(this._normalizeSegment(segment))
          : null;

        history = await observabilityRepo.getDriftHistory(f, days, segmentHash);
      } catch (err) {
        logger.error('[Drift] report fetch failed', { error: err.message });
        report[f] = { status: 'error' };
        continue;
      }

      if (!history.length) {
        report[f] = { status: 'no_data', sampleCount: 0 };
        continue;
      }

      const scoreValues = [];
      const salaryValues = [];
      const confValues = [];

      for (const h of history) {
        if (h.score != null) scoreValues.push(h.score);
        if (h.salaryMedian != null) salaryValues.push(h.salaryMedian);
        if (h.confidenceScore != null) confValues.push(h.confidenceScore);
      }

      report[f] = {
        sampleCount: history.length,
        score: this._computeStats(scoreValues),
        salaryMedian: this._computeStats(salaryValues),
        confidenceScore: this._computeStats(confValues),
      };
    }

    return report;
  }

  _computeStats(values) {
    if (!values || values.length < 2) return null;

    let sum = 0;
    for (const v of values) sum += v;

    const mean = sum / values.length;

    let varianceSum = 0;
    for (const v of values) varianceSum += (v - mean) ** 2;

    const variance = varianceSum / values.length;
    const stdDev = Math.sqrt(variance);
    const latest = values[0];
    const zScore = stdDev > 0 ? (latest - mean) / stdDev : 0;

    return {
      baseline: +mean.toFixed(4),
      stdDev: +stdDev.toFixed(4),
      zScore: +zScore.toFixed(3),
      anomalyFlag: Math.abs(zScore) > 2,
    };
  }

  _safeNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  _shouldSample(key, mod = 10) {
    let hash = 0;

    for (let i = 0; i < key.length; i++) {
      hash = (hash << 5) - hash + key.charCodeAt(i);
      hash |= 0;
    }

    return Math.abs(hash % mod) === 0;
  }

  _normalizeSegment(segment) {
    return segment || {};
  }

  _hashSegment(segment) {
    if (!segment || Object.keys(segment).length === 0) return null;

    const canonical = Object.entries(segment)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('|');

    return crypto.createHash('sha256')
      .update(canonical)
      .digest('hex')
      .slice(0, 16);
  }

  _rollingAverage(records, field) {
    let sum = 0;
    let count = 0;

    for (const r of records) {
      if (r[field] != null && !isNaN(r[field])) {
        sum += r[field];
        count++;
      }
    }

    return count ? +(sum / count).toFixed(4) : null;
  }
}

module.exports = new DriftService();