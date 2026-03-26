'use strict';

const observabilityRepo = require('../../repositories/ai-observability.repository');
const alertService = require('../observability/alert.service');

/**
 * confidence-calibration.service.js
 *
 * Confidence Calibration Tracking — measures how well AI confidence scores
 * predict actual outcome accuracy.
 *
 * WHY THIS IS CRITICAL FOR AI GOVERNANCE:
 *   A model that says "I'm 90% confident" but is only correct 60% of the time
 *   is OVERCONFIDENT. This erodes user trust and creates liability in enterprise contexts
 *   (e.g., salary benchmarks used for compensation decisions, resume scores affecting
 *   hiring pipelines).
 *
 *   Calibration tracking enables:
 *   - Procurement audits: "prove your AI confidence scores are reliable"
 *   - Model comparison: compare calibration of gpt-4o vs claude-3-5-sonnet
 *   - Threshold tuning: adjust UI confidence thresholds based on real data
 *
 * CALIBRATION METRIC — Simplified Expected Calibration Error (ECE):
 *   Group predictions into confidence buckets (0–0.5, 0.5–0.7, 0.7–0.9, 0.9–1.0).
 *   For each bucket: ECE_bucket = |mean_confidence - actual_accuracy|
 *   Overall ECE = weighted average of bucket ECEs.
 *   ECE near 0 = well-calibrated. ECE > 0.1 = governance concern.
 *
 *   Simplified proxy (when ground truth is binary feedback):
 *   Brier Score = mean((confidence - outcome)^2)
 *   Perfect model: Brier = 0. Random: Brier = 0.25.
 *
 * FEEDBACK COLLECTION:
 *   User feedback is optional. Without it, we can only track internal metrics
 *   (e.g., did the user accept a recommendation = proxy for agreement).
 *   Feedback schema: { logId, userId, feature, outcome: 0|1, feedbackType }
 */

const CALIBRATION_THRESHOLDS = {
  overconfidenceECE: 0.10,     // ECE > 10% = overconfidence alert
  underconfidenceECE: 0.10,    // Same threshold, different direction
  brierScoreWarning: 0.15,
  minFeedbackSamples: 30,       // Minimum feedback records before computing
};

class ConfidenceCalibrationService {
  /**
   * Record user feedback for a specific AI call.
   * outcome: 1 = user agreed/accepted, 0 = user disagreed/rejected
   *
   * @param {Object} params
   * @param {string} params.logId       - ai_logs document ID
   * @param {string} params.userId
   * @param {string} params.feature
   * @param {number} params.confidenceScore - original AI confidence (0–1)
   * @param {number} params.outcome     - 0 or 1
   * @param {string} [params.feedbackType] - 'explicit' | 'implicit' | 'downstream'
   */
  async recordFeedback(params) {
    const { logId, userId, feature, confidenceScore, outcome, feedbackType = 'explicit' } = params;

    if (confidenceScore == null || outcome == null) return;
    if (outcome !== 0 && outcome !== 1) throw new Error('outcome must be 0 or 1');

    await observabilityRepo.writeCalibrationFeedback({
      logId,
      userId,
      feature,
      confidenceScore: Number(confidenceScore),
      outcome: Number(outcome),
      feedbackType,
      disagreement: outcome === 0 ? 1 : 0,
    });

    // Check calibration (sampled 1 in 10 to reduce read cost)
    if (Math.random() < 0.1) {
      this._checkCalibration(feature).catch(() => {});
    }
  }

  /**
   * Compute calibration metrics for a feature over a lookback window.
   * Returns ECE, Brier score, overconfidence/underconfidence flags.
   */
  async computeCalibration(feature, { days = 30 } = {}) {
    const feedbackRecords = await observabilityRepo.getCalibrationFeedback(feature, days);

    if (feedbackRecords.length < CALIBRATION_THRESHOLDS.minFeedbackSamples) {
      return {
        feature,
        status: 'insufficient_data',
        sampleCount: feedbackRecords.length,
        minRequired: CALIBRATION_THRESHOLDS.minFeedbackSamples,
      };
    }

    // Brier Score
    const brierScore = this._computeBrierScore(feedbackRecords);

    // Expected Calibration Error (ECE)
    const { ece, buckets, overconfident, underconfident } = this._computeECE(feedbackRecords);

    // Disagreement rate
    const disagreementRate = feedbackRecords.filter(r => r.disagreement).length / feedbackRecords.length;

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
      alerts: this._buildCalibrationAlerts(feature, { ece, brierScore, overconfident }),
    };
  }

  async _checkCalibration(feature) {
    const result = await this.computeCalibration(feature);
    if (result.status === 'insufficient_data') return;

    if (result.ece > CALIBRATION_THRESHOLDS.overconfidenceECE) {
      await alertService.fire({
        type: 'CALIBRATION',
        feature,
        severity: result.ece > 0.20 ? 'CRITICAL' : 'WARNING',
        title: `Confidence calibration issue: ${feature} ECE=${result.ece} (${result.overconfident ? 'overconfident' : 'underconfident'})`,
        detail: { ece: result.ece, brierScore: result.brierScore, grade: result.calibrationGrade },
      });
    }
  }

  _computeBrierScore(records) {
    const sum = records.reduce((s, r) => s + (r.confidenceScore - r.outcome) ** 2, 0);
    return sum / records.length;
  }

  _computeECE(records) {
    // 4 confidence buckets
    const bucketDefs = [
      { label: '0.0–0.5', min: 0.0, max: 0.5 },
      { label: '0.5–0.7', min: 0.5, max: 0.7 },
      { label: '0.7–0.9', min: 0.7, max: 0.9 },
      { label: '0.9–1.0', min: 0.9, max: 1.0 },
    ];

    const n = records.length;
    let weightedSum = 0;
    let overconfidentCount = 0;
    let underconfidentCount = 0;
    const buckets = [];

    for (const def of bucketDefs) {
      const inBucket = records.filter(r => r.confidenceScore >= def.min && r.confidenceScore < def.max);
      if (inBucket.length === 0) continue;

      const meanConf = inBucket.reduce((s, r) => s + r.confidenceScore, 0) / inBucket.length;
      const actualAccuracy = inBucket.reduce((s, r) => s + r.outcome, 0) / inBucket.length;
      const gap = meanConf - actualAccuracy;

      if (gap > 0.05) overconfidentCount += inBucket.length;
      if (gap < -0.05) underconfidentCount += inBucket.length;

      const bucketECE = Math.abs(gap);
      weightedSum += (inBucket.length / n) * bucketECE;

      buckets.push({
        range: def.label,
        sampleCount: inBucket.length,
        meanConfidence: +meanConf.toFixed(4),
        actualAccuracy: +actualAccuracy.toFixed(4),
        gap: +gap.toFixed(4),
        calibrationStatus: Math.abs(gap) < 0.05 ? 'OK' : (gap > 0 ? 'OVERCONFIDENT' : 'UNDERCONFIDENT'),
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
    if (ece < 0.03) return 'A'; // Excellent calibration
    if (ece < 0.07) return 'B'; // Good
    if (ece < 0.12) return 'C'; // Acceptable
    if (ece < 0.20) return 'D'; // Governance concern
    return 'F';                  // Audit flag
  }

  _buildCalibrationAlerts(feature, { ece, brierScore, overconfident }) {
    const alerts = [];
    if (ece > CALIBRATION_THRESHOLDS.overconfidenceECE) {
      alerts.push({
        type: overconfident ? 'OVERCONFIDENCE' : 'UNDERCONFIDENCE',
        ece,
        message: overconfident
          ? 'Model overstates confidence — users may over-rely on AI output'
          : 'Model understates confidence — users may under-utilize AI output',
      });
    }
    if (brierScore > CALIBRATION_THRESHOLDS.brierScoreWarning) {
      alerts.push({ type: 'POOR_BRIER', brierScore, message: 'Prediction quality below threshold' });
    }
    return alerts;
  }
}

module.exports = new ConfidenceCalibrationService();








