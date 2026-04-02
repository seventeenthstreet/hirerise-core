'use strict';

const observabilityRepo = require('../../repositories/ai-observability.repository');
const alertService = require('../observability/alert.service');
const logger = require('../../utils/logger');

const CALIBRATION_THRESHOLDS = {
  overconfidenceECE: 0.10,
  underconfidenceECE: 0.10,
  brierScoreWarning: 0.15,
  minFeedbackSamples: 30,
};

class ConfidenceCalibrationService {

  // ─────────────────────────────────────────────
  // RECORD FEEDBACK
  // ─────────────────────────────────────────────

  async recordFeedback(params) {
    const {
      logId,
      userId,
      feature,
      confidenceScore,
      outcome,
      feedbackType = 'explicit',
    } = params;

    if (confidenceScore == null || outcome == null) return;
    if (outcome !== 0 && outcome !== 1) throw new Error('outcome must be 0 or 1');

    const score = Number(confidenceScore);

    // ✅ validation
    if (Number.isNaN(score) || score < 0 || score > 1) {
      logger.warn('[Calibration] Invalid confidence score', { confidenceScore });
      return;
    }

    // ✅ timeout protection
    await Promise.race([
      observabilityRepo.writeCalibrationFeedback({
        logId,
        userId,
        feature,
        confidenceScore: score,
        outcome: Number(outcome),
        feedbackType,
        disagreement: outcome === 0 ? 1 : 0,
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 2000)
      ),
    ]).catch((err) => {
      logger.error('[Calibration] write failed', { error: err.message });
    });

    // ✅ deterministic sampling (10%)
    if (this._shouldSample(logId)) {
      this._checkCalibration(feature).catch(() => {});
    }
  }

  // ─────────────────────────────────────────────
  // COMPUTE CALIBRATION
  // ─────────────────────────────────────────────

  async computeCalibration(feature, { days = 30 } = {}) {
    let feedbackRecords;

    try {
      feedbackRecords = await observabilityRepo.getCalibrationFeedback(feature, days);
    } catch (err) {
      logger.error('[Calibration] fetch failed', { error: err.message });
      return { feature, status: 'error' };
    }

    if (feedbackRecords.length < CALIBRATION_THRESHOLDS.minFeedbackSamples) {
      return {
        feature,
        status: 'insufficient_data',
        sampleCount: feedbackRecords.length,
        minRequired: CALIBRATION_THRESHOLDS.minFeedbackSamples,
      };
    }

    const brierScore = this._computeBrierScore(feedbackRecords);
    const { ece, buckets, overconfident, underconfident } =
      this._computeECE(feedbackRecords);

    const disagreementRate =
      feedbackRecords.filter(r => r.disagreement).length / feedbackRecords.length;

    return {
      feature,
      sampleCount: feedbackRecords.length,
      brierScore: +brierScore.toFixed(4),
      ece: +ece.toFixed(4),
      disagreementRate: +disagreementRate.toFixed(4),
      overconfident,
      underconfident,
      calibrationGrade: this._grade(ece),
      buckets,
      alerts: this._buildCalibrationAlerts(feature, {
        ece,
        brierScore,
        overconfident,
      }),
    };
  }

  async _checkCalibration(feature) {
    const result = await this.computeCalibration(feature);
    if (!result || result.status === 'insufficient_data') return;

    if (result.ece > CALIBRATION_THRESHOLDS.overconfidenceECE) {
      await alertService.fire({
        type: 'CALIBRATION',
        feature,
        severity: result.ece > 0.20 ? 'CRITICAL' : 'WARNING',
        title: `Calibration issue: ${feature} ECE=${result.ece}`,
        detail: {
          ece: result.ece,
          brierScore: result.brierScore,
          grade: result.calibrationGrade,
        },
      });
    }
  }

  // ─────────────────────────────────────────────
  // METRICS
  // ─────────────────────────────────────────────

  _computeBrierScore(records) {
    let sum = 0;

    for (const r of records) {
      sum += (r.confidenceScore - r.outcome) ** 2;
    }

    return sum / records.length;
  }

  _computeECE(records) {
    const bucketsMap = {
      '0.0–0.5': [],
      '0.5–0.7': [],
      '0.7–0.9': [],
      '0.9–1.0': [],
    };

    // ✅ single pass bucketing (performance fix)
    for (const r of records) {
      const c = r.confidenceScore;

      if (c < 0.5) bucketsMap['0.0–0.5'].push(r);
      else if (c < 0.7) bucketsMap['0.5–0.7'].push(r);
      else if (c < 0.9) bucketsMap['0.7–0.9'].push(r);
      else bucketsMap['0.9–1.0'].push(r);
    }

    const n = records.length;
    let weightedSum = 0;
    let overconfidentCount = 0;
    let underconfidentCount = 0;
    const buckets = [];

    for (const [label, bucket] of Object.entries(bucketsMap)) {
      if (!bucket.length) continue;

      let confSum = 0;
      let outcomeSum = 0;

      for (const r of bucket) {
        confSum += r.confidenceScore;
        outcomeSum += r.outcome;
      }

      const meanConf = confSum / bucket.length;
      const actualAccuracy = outcomeSum / bucket.length;
      const gap = meanConf - actualAccuracy;

      if (gap > 0.05) overconfidentCount += bucket.length;
      if (gap < -0.05) underconfidentCount += bucket.length;

      const bucketECE = Math.abs(gap);
      weightedSum += (bucket.length / n) * bucketECE;

      buckets.push({
        range: label,
        sampleCount: bucket.length,
        meanConfidence: +meanConf.toFixed(4),
        actualAccuracy: +actualAccuracy.toFixed(4),
        gap: +gap.toFixed(4),
        calibrationStatus:
          Math.abs(gap) < 0.05
            ? 'OK'
            : gap > 0
            ? 'OVERCONFIDENT'
            : 'UNDERCONFIDENT',
      });
    }

    return {
      ece: weightedSum,
      buckets,
      overconfident: overconfidentCount > underconfidentCount,
      underconfident: underconfidentCount > overconfidentCount,
    };
  }

  _grade(ece) {
    if (ece < 0.03) return 'A';
    if (ece < 0.07) return 'B';
    if (ece < 0.12) return 'C';
    if (ece < 0.20) return 'D';
    return 'F';
  }

  _buildCalibrationAlerts(feature, { ece, brierScore, overconfident }) {
    const alerts = [];

    if (ece > CALIBRATION_THRESHOLDS.overconfidenceECE) {
      alerts.push({
        type: overconfident ? 'OVERCONFIDENCE' : 'UNDERCONFIDENCE',
        ece,
        message: overconfident
          ? 'Model overstates confidence'
          : 'Model understates confidence',
      });
    }

    if (brierScore > CALIBRATION_THRESHOLDS.brierScoreWarning) {
      alerts.push({
        type: 'POOR_BRIER',
        brierScore,
        message: 'Prediction quality below threshold',
      });
    }

    return alerts;
  }

  // ─────────────────────────────────────────────
  // UTIL
  // ─────────────────────────────────────────────

  _shouldSample(key = '') {
    // deterministic hash sampling
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = (hash << 5) - hash + key.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash % 10) === 0; // 10%
  }
}

module.exports = new ConfidenceCalibrationService();