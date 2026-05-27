'use strict';

/**
 * signal-coverage.model.js
 *
 * Signal Coverage Engine — Phase 4A
 *
 * Measures: "How complete and reliable is the user intelligence profile?"
 *
 * Coverage is NOT:
 *   - confidence scoring
 *   - consistency scoring
 *   - domain affinity
 *
 * Coverage IS:
 *   - signal breadth   (how many trait dimensions were reached)
 *   - signal depth     (how thoroughly each dimension was explored)
 *   - trait completeness (how many traits have adequate sample counts)
 *   - assessment completeness (how many stages were completed)
 *   - scoring reliability (per-trait trustworthiness weight)
 *
 * Architecture constraints:
 *   - pure functions only
 *   - deterministic (same input → same output, always)
 *   - no AI, no ML, no hidden heuristics
 *   - no side effects
 *   - governance-safe: cannot mutate raw signal values
 */

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────

const COVERAGE_WEIGHTS = Object.freeze({
  traitBreadth:          0.25,
  stageCompleteness:     0.25,
  sampleAdequacy:        0.20,
  questionDiversity:     0.15,
  contradictionPenalty:  0.10,
  sparsityPenalty:       0.05,
});

const COVERAGE_THRESHOLDS = Object.freeze({
  HIGH:   80,
  MEDIUM: 55,
  LOW:    0,
});

const SAMPLE_ADEQUACY_THRESHOLDS = Object.freeze({
  STRONG:   5,
  ADEQUATE: 3,
  WEAK:     1,
});

const CONTRADICTION_PENALTY_PER_OCCURRENCE = 3.5; // percentage points
const ABANDONMENT_PENALTY_PER_STAGE        = 8.0;
const SPARSITY_PENALTY_PER_GAP             = 4.0;

// ─────────────────────────────────────────────────────────────
// MAIN ENTRY POINT
// ─────────────────────────────────────────────────────────────

/**
 * Evaluates signal coverage for a user's assessment profile.
 *
 * @param {object} params
 * @param {string[]}  params.evaluatedTraits         — trait keys assessed this session
 * @param {string[]}  params.expectedTraits          — full trait catalogue expected for domain
 * @param {number}    params.completedStages         — count of fully completed assessment stages
 * @param {number}    params.totalStages             — count of assessment stages in the track
 * @param {number}    params.abandonedStages         — count of incomplete / abandoned stages
 * @param {object}    params.traitSampleCounts       — { [traitKey]: sampleCount }
 * @param {string[]}  params.questionCategories      — category tag per question answered
 * @param {number}    params.contradictoryAnswers    — count of flagged contradictory answer pairs
 * @param {number}    params.adaptiveFollowUpTotal   — total adaptive follow-up questions issued
 * @param {number}    params.adaptiveFollowUpAnswered — answered adaptive follow-up questions
 * @param {object}    [params.config]                — optional threshold overrides
 *
 * @returns {SignalCoverageResult}
 */
function evaluateSignalCoverage({
  evaluatedTraits          = [],
  expectedTraits           = [],
  completedStages          = 0,
  totalStages              = 1,
  abandonedStages          = 0,
  traitSampleCounts        = {},
  questionCategories       = [],
  contradictoryAnswers     = 0,
  adaptiveFollowUpTotal    = 0,
  adaptiveFollowUpAnswered = 0,
  config                   = {},
}) {
  const weights = _mergeWeights(config.weights);

  // ── Factor 1: Trait Breadth ─────────────────────────────────
  const traitBreadthRaw = _computeTraitBreadth(evaluatedTraits, expectedTraits);

  // ── Factor 2: Stage Completeness ───────────────────────────
  const stageCompletenessRaw = _computeStageCompleteness(
    completedStages,
    totalStages,
    abandonedStages
  );

  // ── Factor 3: Sample Adequacy ──────────────────────────────
  const sampleAdequacyRaw = _computeSampleAdequacy(evaluatedTraits, traitSampleCounts, config);

  // ── Factor 4: Question Diversity ──────────────────────────
  const questionDiversityRaw = _computeQuestionDiversity(questionCategories);

  // ── Factor 5: Contradiction Penalty ───────────────────────
  const contradictionPenaltyRaw = _computeContradictionPenalty(
    contradictoryAnswers,
    questionCategories.length,
    config
  );

  // ── Factor 6: Signal Sparsity ──────────────────────────────
  const sparsityPenaltyRaw = _computeSparsityPenalty(evaluatedTraits, expectedTraits, traitSampleCounts, config);

  // ── Weighted composite ─────────────────────────────────────
  const positiveContribution =
    weights.traitBreadth      * traitBreadthRaw +
    weights.stageCompleteness * stageCompletenessRaw +
    weights.sampleAdequacy    * sampleAdequacyRaw +
    weights.questionDiversity * questionDiversityRaw;

  const negativeContribution =
    weights.contradictionPenalty * contradictionPenaltyRaw +
    weights.sparsityPenalty      * sparsityPenaltyRaw;

  const coverageScore = clamp(positiveContribution - negativeContribution, 0, 100);
  const coverageLevel = _classifyCoverage(coverageScore, config.thresholds);

  // ── Adaptive follow-up bonus ───────────────────────────────
  const adaptiveCompletionRate = _safeRatio(adaptiveFollowUpAnswered, adaptiveFollowUpTotal);
  const adaptiveBonus = round(adaptiveCompletionRate * 5); // max +5 pts

  const finalCoverageScore = clamp(coverageScore + adaptiveBonus, 0, 100);
  const finalCoverageLevel = _classifyCoverage(finalCoverageScore, config.thresholds);

  return {
    coverageScore:       round(finalCoverageScore),
    coverageLevel:       finalCoverageLevel,
    coverageNotes:       _buildCoverageNotes(
      traitBreadthRaw,
      stageCompletenessRaw,
      sampleAdequacyRaw,
      contradictionPenaltyRaw,
      sparsityPenaltyRaw,
      adaptiveCompletionRate,
      config.thresholds
    ),
    factors: {
      traitBreadth:          round(traitBreadthRaw),
      stageCompleteness:     round(stageCompletenessRaw),
      sampleAdequacy:        round(sampleAdequacyRaw),
      questionDiversity:     round(questionDiversityRaw),
      contradictionPenalty:  round(contradictionPenaltyRaw),
      sparsityPenalty:       round(sparsityPenaltyRaw),
      adaptiveBonus:         adaptiveBonus,
    },
    traitGaps:  _identifyTraitGaps(evaluatedTraits, expectedTraits, traitSampleCounts, config),
    meta: {
      weights,
      evaluatedTraitCount:  evaluatedTraits.length,
      expectedTraitCount:   expectedTraits.length,
      completedStages,
      totalStages,
      abandonedStages,
      contradictoryAnswers,
      adaptiveFollowUpTotal,
      adaptiveFollowUpAnswered,
      evaluatedAt: new Date().toISOString(),
      engineVersion: 'signal-coverage-v1',
    },
  };
}

// ─────────────────────────────────────────────────────────────
// FACTOR COMPUTATIONS
// ─────────────────────────────────────────────────────────────

function _computeTraitBreadth(evaluatedTraits, expectedTraits) {
  if (!expectedTraits.length) return 100;
  const evaluated = new Set(evaluatedTraits);
  const covered = expectedTraits.filter(t => evaluated.has(t)).length;
  return _safeRatio(covered, expectedTraits.length) * 100;
}

function _computeStageCompleteness(completedStages, totalStages, abandonedStages) {
  if (totalStages === 0) return 100;
  const raw = _safeRatio(completedStages, totalStages) * 100;
  const penalty = abandonedStages * ABANDONMENT_PENALTY_PER_STAGE;
  return clamp(raw - penalty, 0, 100);
}

function _computeSampleAdequacy(evaluatedTraits, traitSampleCounts, config = {}) {
  if (!evaluatedTraits.length) return 0;

  const strongThreshold   = config.sampleStrongThreshold   ?? SAMPLE_ADEQUACY_THRESHOLDS.STRONG;
  const adequateThreshold = config.sampleAdequateThreshold ?? SAMPLE_ADEQUACY_THRESHOLDS.ADEQUATE;
  const weakThreshold     = config.sampleWeakThreshold     ?? SAMPLE_ADEQUACY_THRESHOLDS.WEAK;

  let totalWeight = 0;

  for (const trait of evaluatedTraits) {
    const count = traitSampleCounts[trait] ?? 0;
    if (count >= strongThreshold)   totalWeight += 1.0;
    else if (count >= adequateThreshold) totalWeight += 0.65;
    else if (count >= weakThreshold)     totalWeight += 0.30;
    // count === 0 → 0 contribution
  }

  return _safeRatio(totalWeight, evaluatedTraits.length) * 100;
}

function _computeQuestionDiversity(questionCategories) {
  if (!questionCategories.length) return 0;
  const uniqueCategories = new Set(questionCategories).size;
  // Full diversity = 5+ distinct categories
  const fullDiversityThreshold = 5;
  return clamp(_safeRatio(uniqueCategories, fullDiversityThreshold) * 100, 0, 100);
}

function _computeContradictionPenalty(contradictoryAnswers, totalQuestions, config = {}) {
  if (!totalQuestions) return 0;
  const penaltyPerOccurrence = config.contradictionPenaltyPerOccurrence
    ?? CONTRADICTION_PENALTY_PER_OCCURRENCE;
  return clamp(contradictoryAnswers * penaltyPerOccurrence, 0, 50);
}

function _computeSparsityPenalty(evaluatedTraits, expectedTraits, traitSampleCounts, config = {}) {
  const penaltyPerGap = config.sparsityPenaltyPerGap ?? SPARSITY_PENALTY_PER_GAP;
  const evaluated = new Set(evaluatedTraits);
  const missingTraits = expectedTraits.filter(t => !evaluated.has(t));

  // Additional penalty for evaluated traits with zero samples
  const zeroSampleTraits = evaluatedTraits.filter(t => (traitSampleCounts[t] ?? 0) === 0);

  const totalGaps = missingTraits.length + zeroSampleTraits.length;
  return clamp(totalGaps * penaltyPerGap, 0, 50);
}

// ─────────────────────────────────────────────────────────────
// CLASSIFICATION
// ─────────────────────────────────────────────────────────────

function _classifyCoverage(score, thresholds = {}) {
  const high   = thresholds.HIGH   ?? COVERAGE_THRESHOLDS.HIGH;
  const medium = thresholds.MEDIUM ?? COVERAGE_THRESHOLDS.MEDIUM;

  if (score >= high)   return 'HIGH';
  if (score >= medium) return 'MEDIUM';
  return 'LOW';
}

// ─────────────────────────────────────────────────────────────
// TRAIT GAP IDENTIFICATION
// ─────────────────────────────────────────────────────────────

function _identifyTraitGaps(evaluatedTraits, expectedTraits, traitSampleCounts, config = {}) {
  const evaluated = new Set(evaluatedTraits);
  const weakThreshold = config.sampleWeakThreshold ?? SAMPLE_ADEQUACY_THRESHOLDS.WEAK;

  const missing = expectedTraits
    .filter(t => !evaluated.has(t))
    .map(t => ({ trait: t, reason: 'not_assessed' }));

  const sparse = evaluatedTraits
    .filter(t => (traitSampleCounts[t] ?? 0) < weakThreshold)
    .map(t => ({ trait: t, reason: 'insufficient_samples', sampleCount: traitSampleCounts[t] ?? 0 }));

  return [...missing, ...sparse];
}

// ─────────────────────────────────────────────────────────────
// COVERAGE NOTES BUILDER
// ─────────────────────────────────────────────────────────────

function _buildCoverageNotes(
  traitBreadth,
  stageCompleteness,
  sampleAdequacy,
  contradictionPenalty,
  sparsityPenalty,
  adaptiveCompletionRate,
  thresholds = {}
) {
  const high   = thresholds.HIGH   ?? COVERAGE_THRESHOLDS.HIGH;
  const medium = thresholds.MEDIUM ?? COVERAGE_THRESHOLDS.MEDIUM;

  const notes = [];

  if (stageCompleteness >= high)       notes.push('completed all assessment stages');
  else if (stageCompleteness >= medium) notes.push('most assessment stages completed');
  else                                  notes.push('incomplete assessment stages detected');

  if (traitBreadth >= high)       notes.push('strong trait coverage');
  else if (traitBreadth >= medium) notes.push('partial trait coverage — additional traits recommended');
  else                             notes.push('low trait breadth — significant trait gaps detected');

  if (sampleAdequacy >= high)       notes.push('adequate trait sample depth');
  else if (sampleAdequacy >= medium) notes.push('moderate sample depth — reassessment may improve quality');
  else                               notes.push('low signal depth — insufficient samples for several traits');

  if (contradictionPenalty > 10)   notes.push('notable contradictory answers detected');
  if (sparsityPenalty > 10)        notes.push('signal sparsity detected — some trait areas not assessed');
  if (adaptiveCompletionRate >= 0.8) notes.push('strong adaptive follow-up completion');

  return notes;
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function _mergeWeights(overrides = {}) {
  return { ...COVERAGE_WEIGHTS, ...overrides };
}

function _safeRatio(numerator, denominator) {
  if (!denominator || denominator === 0) return 0;
  return Math.min(1, Math.max(0, numerator / denominator));
}

function clamp(value, min = 0, max = 100) {
  const num = Number(value);
  if (!Number.isFinite(num)) return min;
  return Math.min(max, Math.max(min, num));
}

function round(value) {
  return parseFloat(Number(value).toFixed(2));
}

module.exports = {
  evaluateSignalCoverage,
  // Exported for unit testing
  _computeTraitBreadth,
  _computeStageCompleteness,
  _computeSampleAdequacy,
  _computeQuestionDiversity,
  _computeContradictionPenalty,
  _computeSparsityPenalty,
  _classifyCoverage,
  _identifyTraitGaps,
  COVERAGE_WEIGHTS,
  COVERAGE_THRESHOLDS,
};
