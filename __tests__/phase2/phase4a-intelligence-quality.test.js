'use strict';

/**
 * phase4a-intelligence-quality.test.js
 *
 * Unit tests for Phase 4A intelligence quality systems:
 *   - signal-coverage.model
 *   - signal-reliability.model
 *   - cluster-stability.model
 *   - cluster-drift.model
 *   - signal-sparsity.model
 *   - intelligence-quality.explainability
 *   - intelligence-quality.analytics
 *
 * All tests are deterministic and input-output only.
 * No mocks of external systems are required.
 *
 * Run: node --test phase4a-intelligence-quality.test.js
 * Or with Jest: jest phase4a-intelligence-quality.test.js
 */

const assert = require('assert');

const {
  evaluateSignalCoverage,
  _computeTraitBreadth,
  _computeStageCompleteness,
  _computeSampleAdequacy,
  _classifyCoverage,
} = require('../../src/intelligence/models/signal-coverage.model');

const {
  evaluateSignalReliability,
  _computeSampleVolumeScore,
  _computeRecencyScore,
} = require('../../src/intelligence/models/signal-reliability.model');

const {
  evaluateClusterStability,
  _computeAppearanceConsistency,
  _computeScoreVarianceStability,
  _computeTrendStrength,
} = require('../../src/intelligence/models/cluster-stability.model');

const {
  evaluateClusterDrift,
  evaluateLongitudinalDrift,
  _classifyDrift,
  DRIFT_LEVELS,
} = require('../../src/intelligence/models/cluster-drift.model');

const {
  evaluateSignalSparsity,
  SUPPRESSION_REASONS,
} = require('../../src/intelligence/models/signal-sparsity.model');

const {
  explainSignalCoverage,
  explainClusterStability,
  explainAssessmentQuality,
} = require('../../src/intelligence/models/intelligence-quality.explainability');

const {
  buildSignalCoverageEvaluatedEvent,
  buildLowSignalCoverageDetectedEvent,
  buildClusterDriftDetectedEvent,
  buildReliabilityThresholdCrossedEvent,
} = require('../../src/intelligence/models/intelligence-quality.analytics');

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

function assertBetween(value, min, max, label = 'value') {
  assert.ok(
    value >= min && value <= max,
    `${label} expected between ${min} and ${max}, got ${value}`
  );
}

// ─────────────────────────────────────────────────────────────
// SIGNAL COVERAGE TESTS
// ─────────────────────────────────────────────────────────────

console.log('\n── Signal Coverage Model ──');

test('trait breadth: full coverage → 100', () => {
  const score = _computeTraitBreadth(['a', 'b', 'c'], ['a', 'b', 'c']);
  assert.strictEqual(score, 100);
});

test('trait breadth: no coverage → 0', () => {
  const score = _computeTraitBreadth([], ['a', 'b', 'c']);
  assert.strictEqual(score, 0);
});

test('trait breadth: 50% coverage → 50', () => {
  const score = _computeTraitBreadth(['a', 'b'], ['a', 'b', 'c', 'd']);
  assert.strictEqual(score, 50);
});

test('stage completeness: all complete, no abandonment → 100', () => {
  const score = _computeStageCompleteness(5, 5, 0);
  assert.strictEqual(score, 100);
});

test('stage completeness: abandonment penalty applied', () => {
  const score = _computeStageCompleteness(4, 5, 1); // 80% complete - 8 pts penalty
  assertBetween(score, 0, 80, 'stage completeness with abandonment');
});

test('sample adequacy: all traits with strong samples → high score', () => {
  const score = _computeSampleAdequacy(
    ['a', 'b', 'c'],
    { a: 7, b: 6, c: 8 }
  );
  assertBetween(score, 90, 100, 'sample adequacy');
});

test('sample adequacy: all traits with zero samples → 0', () => {
  const score = _computeSampleAdequacy(['a', 'b'], { a: 0, b: 0 });
  assert.strictEqual(score, 0);
});

test('coverage classification: 85 → HIGH', () => {
  assert.strictEqual(_classifyCoverage(85), 'HIGH');
});

test('coverage classification: 65 → MEDIUM', () => {
  assert.strictEqual(_classifyCoverage(65), 'MEDIUM');
});

test('coverage classification: 30 → LOW', () => {
  assert.strictEqual(_classifyCoverage(30), 'LOW');
});

test('full coverage evaluation: comprehensive input → valid output', () => {
  const result = evaluateSignalCoverage({
    evaluatedTraits:    ['analytical_thinking', 'communication', 'problem_solving'],
    expectedTraits:     ['analytical_thinking', 'communication', 'problem_solving', 'leadership'],
    completedStages:    4,
    totalStages:        5,
    abandonedStages:    1,
    traitSampleCounts:  { analytical_thinking: 6, communication: 4, problem_solving: 5 },
    questionCategories: ['logical', 'verbal', 'quantitative', 'social', 'creative'],
    contradictoryAnswers: 1,
    adaptiveFollowUpTotal: 3,
    adaptiveFollowUpAnswered: 3,
  });

  assert.ok(result.coverageScore >= 0 && result.coverageScore <= 100, 'score in range');
  assert.ok(['HIGH', 'MEDIUM', 'LOW'].includes(result.coverageLevel), 'valid level');
  assert.ok(Array.isArray(result.coverageNotes), 'notes array');
  assert.ok(Array.isArray(result.traitGaps), 'gaps array');
  assert.ok(result.traitGaps.some(g => g.trait === 'leadership'), 'missing trait flagged');
  assert.strictEqual(result.meta.engineVersion, 'signal-coverage-v1');
});

test('coverage evaluation: empty input → low coverage score', () => {
  const result = evaluateSignalCoverage({
    evaluatedTraits: [],
    expectedTraits:  ['a', 'b', 'c'],
    completedStages: 0,
    totalStages:     3,
  });
  assert.strictEqual(result.coverageLevel, 'LOW');
  assert.ok(result.coverageScore < 30, 'empty → very low score');
});

// ─────────────────────────────────────────────────────────────
// SIGNAL RELIABILITY TESTS
// ─────────────────────────────────────────────────────────────

console.log('\n── Signal Reliability Model ──');

test('sample volume: 7+ samples → 100', () => {
  assert.strictEqual(_computeSampleVolumeScore(7), 100);
  assert.strictEqual(_computeSampleVolumeScore(10), 100);
});

test('sample volume: 0 samples → 0', () => {
  assert.strictEqual(_computeSampleVolumeScore(0), 0);
});

test('sample volume: 3 samples → 65', () => {
  assert.strictEqual(_computeSampleVolumeScore(3), 65);
});

test('recency: no date → 50 (neutral)', () => {
  const score = _computeRecencyScore(null, new Date());
  assert.strictEqual(score, 50);
});

test('recency: today → 100', () => {
  const score = _computeRecencyScore(new Date().toISOString(), new Date());
  assert.strictEqual(score, 100);
});

test('recency: 180 days ago → below 50 (past decay window)', () => {
  const old = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
  const score = _computeRecencyScore(old.toISOString(), new Date());
  assert.ok(score < 50, `recency should be low for 180 days ago, got ${score}`);
});

test('reliability does NOT mutate raw scores', () => {
  const signals = [
    { traitKey: 'analytical', rawScore: 84, sampleCount: 6, answerConsistencyScore: 90 },
    { traitKey: 'communication', rawScore: 62, sampleCount: 2, answerConsistencyScore: 60 },
  ];

  const result = evaluateSignalReliability({ traitSignals: signals });

  // Raw scores must be preserved exactly
  const aProfile = result.traitReliabilityProfiles.find(p => p.traitKey === 'analytical');
  const cProfile = result.traitReliabilityProfiles.find(p => p.traitKey === 'communication');

  assert.strictEqual(aProfile.rawScore, 84, 'analytical raw score unchanged');
  assert.strictEqual(cProfile.rawScore, 62, 'communication raw score unchanged');
});

test('reliability: high-sample, consistent trait → HIGH reliability', () => {
  const result = evaluateSignalReliability({
    traitSignals: [{
      traitKey:              'analytical',
      rawScore:              84,
      sampleCount:           8,
      answerConsistencyScore: 95,
      lastAssessedAt:        new Date().toISOString(),
    }],
    crossTraitConsistencyMap: { analytical: 90 },
  });

  const profile = result.traitReliabilityProfiles[0];
  assert.strictEqual(profile.reliabilityLevel, 'HIGH');
});

test('reliability: zero-sample trait → LOW reliability', () => {
  const result = evaluateSignalReliability({
    traitSignals: [{
      traitKey:              'unknown',
      rawScore:              50,
      sampleCount:           0,
      answerConsistencyScore: 30,
    }],
  });

  const profile = result.traitReliabilityProfiles[0];
  assert.strictEqual(profile.reliabilityLevel, 'LOW');
});

// ─────────────────────────────────────────────────────────────
// CLUSTER STABILITY TESTS
// ─────────────────────────────────────────────────────────────

console.log('\n── Cluster Stability Model ──');

test('appearance consistency: appeared in all assessments → 100', () => {
  assert.strictEqual(_computeAppearanceConsistency(5, 5), 100);
});

test('appearance consistency: never appeared → 0', () => {
  assert.strictEqual(_computeAppearanceConsistency(0, 5), 0);
});

test('score variance: identical scores → 100 stability', () => {
  const score = _computeScoreVarianceStability([80, 80, 80]);
  assert.strictEqual(score, 100);
});

test('score variance: wildly varying scores → low stability', () => {
  const score = _computeScoreVarianceStability([20, 90, 30, 85]);
  assert.ok(score < 50, `high variance should yield low stability, got ${score}`);
});

test('trend: rising scores → RISING direction', () => {
  const appearances = [
    { assessedAt: '2026-01-01', clusterScore: 50 },
    { assessedAt: '2026-02-01', clusterScore: 60 },
    { assessedAt: '2026-03-01', clusterScore: 70 },
  ];
  const { trendDirection } = _computeTrendStrength(appearances);
  assert.strictEqual(trendDirection, 'RISING');
});

test('trend: stable scores → STABLE direction', () => {
  const appearances = [
    { assessedAt: '2026-01-01', clusterScore: 75 },
    { assessedAt: '2026-02-01', clusterScore: 76 },
    { assessedAt: '2026-03-01', clusterScore: 74 },
  ];
  const { trendDirection } = _computeTrendStrength(appearances);
  assert.strictEqual(trendDirection, 'STABLE');
});

test('stability: cluster seen in 3+ assessments with stable scores → HIGH', () => {
  const result = evaluateClusterStability({
    clusterHistories: [{
      clusterId:    'analytical_systems',
      clusterLabel: 'Analytical Systems',
      appearances: [
        { assessmentId: 'a1', assessedAt: '2026-01-01', clusterScore: 78, clusterRank: 1 },
        { assessmentId: 'a2', assessedAt: '2026-02-01', clusterScore: 80, clusterRank: 1 },
        { assessmentId: 'a3', assessedAt: '2026-03-01', clusterScore: 79, clusterRank: 1 },
      ],
    }],
    totalAssessments: 3,
  });

  const profile = result.clusterStabilityProfiles[0];
  assert.strictEqual(profile.stabilityLevel, 'HIGH');
  assert.strictEqual(result.primaryCluster?.clusterId, 'analytical_systems');
});

test('stability: cluster seen once → UNSTABLE (dampening)', () => {
  const result = evaluateClusterStability({
    clusterHistories: [{
      clusterId:    'leadership',
      clusterLabel: 'Leadership',
      appearances: [
        { assessmentId: 'a1', assessedAt: '2026-01-01', clusterScore: 85, clusterRank: 1 },
      ],
    }],
    totalAssessments: 3,
  });

  const profile = result.clusterStabilityProfiles[0];
  // With dampening, should not be HIGH even though score looks good
  assert.ok(
    profile.stabilityLevel === 'EMERGING' || profile.stabilityLevel === 'UNSTABLE',
    `single-appearance cluster should not be HIGH, got ${profile.stabilityLevel}`
  );
});

// ─────────────────────────────────────────────────────────────
// CLUSTER DRIFT TESTS
// ─────────────────────────────────────────────────────────────

console.log('\n── Cluster Drift Model ──');

test('drift classification: score < 10 → None', () => {
  assert.strictEqual(_classifyDrift(5), DRIFT_LEVELS.NONE);
});

test('drift classification: score 15 → Minor', () => {
  assert.strictEqual(_classifyDrift(15), DRIFT_LEVELS.MINOR);
});

test('drift classification: score 25 → Moderate', () => {
  assert.strictEqual(_classifyDrift(25), DRIFT_LEVELS.MODERATE);
});

test('drift classification: score 35 → Significant', () => {
  assert.strictEqual(_classifyDrift(35), DRIFT_LEVELS.SIGNIFICANT);
});

test('drift: same cluster, same score → None drift', () => {
  const result = evaluateClusterDrift({
    previousSnapshot: {
      assessmentId: 'a1',
      assessedAt: '2026-01-01',
      primaryCluster: { clusterId: 'analytical', clusterLabel: 'Analytical Systems', score: 80 },
      allClusters: [{ clusterId: 'analytical', clusterLabel: 'Analytical Systems', score: 80, rank: 1 }],
    },
    currentSnapshot: {
      assessmentId: 'a2',
      assessedAt: '2026-02-01',
      primaryCluster: { clusterId: 'analytical', clusterLabel: 'Analytical Systems', score: 80 },
      allClusters: [{ clusterId: 'analytical', clusterLabel: 'Analytical Systems', score: 80, rank: 1 }],
    },
  });

  assert.strictEqual(result.driftLevel, DRIFT_LEVELS.NONE);
  assert.strictEqual(result.clusterSwapped, false);
});

test('drift: cluster swap → at least Minor drift', () => {
  const result = evaluateClusterDrift({
    previousSnapshot: {
      assessmentId: 'a1',
      assessedAt: '2026-01-01',
      primaryCluster: { clusterId: 'communicator', clusterLabel: 'Communicator', score: 75 },
      allClusters: [
        { clusterId: 'communicator', score: 75, rank: 1 },
        { clusterId: 'strategic',    score: 60, rank: 2 },
      ],
    },
    currentSnapshot: {
      assessmentId: 'a2',
      assessedAt: '2026-03-01',
      primaryCluster: { clusterId: 'strategic', clusterLabel: 'Strategic Thinking', score: 78 },
      allClusters: [
        { clusterId: 'strategic',    score: 78, rank: 1 },
        { clusterId: 'communicator', score: 70, rank: 2 },
      ],
    },
  });

  assert.strictEqual(result.clusterSwapped, true);
  assert.ok(result.driftLevel !== DRIFT_LEVELS.NONE, 'cluster swap must produce drift');
});

test('drift: null snapshots → None drift with explanation', () => {
  const result = evaluateClusterDrift({ previousSnapshot: null, currentSnapshot: null });
  assert.strictEqual(result.driftLevel, DRIFT_LEVELS.NONE);
  assert.ok(result.explanation.length > 0);
});

test('longitudinal drift: 3 stable assessments → low overall drift', () => {
  const snapshots = [
    {
      assessmentId: 'a1', assessedAt: '2026-01-01',
      primaryCluster: { clusterId: 'analytical', score: 78 },
      allClusters: [{ clusterId: 'analytical', score: 78, rank: 1 }],
    },
    {
      assessmentId: 'a2', assessedAt: '2026-02-01',
      primaryCluster: { clusterId: 'analytical', score: 79 },
      allClusters: [{ clusterId: 'analytical', score: 79, rank: 1 }],
    },
    {
      assessmentId: 'a3', assessedAt: '2026-03-01',
      primaryCluster: { clusterId: 'analytical', score: 80 },
      allClusters: [{ clusterId: 'analytical', score: 80, rank: 1 }],
    },
  ];

  const result = evaluateLongitudinalDrift(snapshots);
  assert.ok(result.averageDriftScore < 20, `stable history should have low avg drift: ${result.averageDriftScore}`);
  assert.strictEqual(result.identityStability, 'STABLE');
});

// ─────────────────────────────────────────────────────────────
// SIGNAL SPARSITY TESTS
// ─────────────────────────────────────────────────────────────

console.log('\n── Signal Sparsity Model ──');

test('sparsity: high coverage, high reliability → no suppression', () => {
  const result = evaluateSignalSparsity({
    coverageScore:           85,
    coverageLevel:           'HIGH',
    averageReliabilityScore: 80,
    evaluatedTraitCount:     5,
    contradictoryAnswers:    0,
    totalQuestionsAnswered:  20,
    completedStages:         5,
    totalStages:             5,
  });

  assert.strictEqual(result.suppressRecommendations, false);
  assert.strictEqual(result.sparsityLevel, 'NONE');
});

test('sparsity: low coverage → suppression active', () => {
  const result = evaluateSignalSparsity({
    coverageScore:           25,
    coverageLevel:           'LOW',
    averageReliabilityScore: 40,
    evaluatedTraitCount:     1,
    completedStages:         1,
    totalStages:             5,
  });

  assert.strictEqual(result.suppressRecommendations, true);
  assert.ok(result.suppressionFlags.length >= 1, 'at least one suppression flag');
});

test('sparsity: insufficient traits → INSUFFICIENT_TRAITS flag', () => {
  const result = evaluateSignalSparsity({
    coverageScore:          55,
    coverageLevel:          'MEDIUM',
    averageReliabilityScore: 60,
    evaluatedTraitCount:    1, // below minimum of 3
    completedStages:        3,
    totalStages:            5,
  });

  const flag = result.suppressionFlags.find(f => f.reason === SUPPRESSION_REASONS.INSUFFICIENT_TRAITS);
  assert.ok(flag, 'INSUFFICIENT_TRAITS flag should be present');
});

test('sparsity: high contradiction rate → warning flag', () => {
  const result = evaluateSignalSparsity({
    coverageScore:           60,
    coverageLevel:           'MEDIUM',
    averageReliabilityScore: 65,
    evaluatedTraitCount:     5,
    contradictoryAnswers:    8,   // 8/20 = 40% > 25% threshold
    totalQuestionsAnswered:  20,
    completedStages:         4,
    totalStages:             5,
  });

  const warning = result.warningFlags.find(f => f.reason === SUPPRESSION_REASONS.HIGH_CONTRADICTION_RATE);
  assert.ok(warning, 'HIGH_CONTRADICTION_RATE warning should be present');
});

test('sparsity: user-facing warning is generated when suppressed', () => {
  const result = evaluateSignalSparsity({
    coverageScore:          20,
    coverageLevel:          'LOW',
    averageReliabilityScore: 30,
    evaluatedTraitCount:    1,
    completedStages:        0,
    totalStages:            5,
  });

  assert.ok(result.userFacingWarning?.length > 10, 'user-facing warning should be non-trivial');
});

// ─────────────────────────────────────────────────────────────
// EXPLAINABILITY TESTS
// ─────────────────────────────────────────────────────────────

console.log('\n── Explainability ──');

test('explain coverage: HIGH level → positive headline', () => {
  const explanation = explainSignalCoverage({
    coverageScore: 88,
    coverageLevel: 'HIGH',
    coverageNotes: ['completed all assessment stages', 'strong trait coverage'],
    traitGaps: [],
  });

  assert.ok(explanation.headline.length > 0);
  assert.ok(explanation.detail.length > 0);
  assert.strictEqual(explanation.level, 'HIGH');
});

test('explain cluster stability: HIGH → includes assessment count', () => {
  const explanation = explainClusterStability({
    clusterLabel:    'Analytical Systems',
    stabilityLevel:  'HIGH',
    appearanceCount: 3,
    trendDirection:  'STABLE',
  });

  assert.ok(explanation.headline.includes('High'), 'headline should mention High');
  assert.ok(explanation.detail.includes('3'), 'detail should include appearance count');
});

test('explain assessment quality: suppressed → warns user', () => {
  const explanation = explainAssessmentQuality({
    coverageResult: {
      coverageScore: 20,
      coverageLevel: 'LOW',
    },
    reliabilityResult: {
      summary: { overallReliabilityLevel: 'LOW' },
    },
    sparsityResult: {
      suppressRecommendations: true,
      sparsityLevel: 'CRITICAL',
      warningFlags: [],
      userFacingWarning: 'Your assessment needs more data.',
    },
  });

  assert.ok(explanation.qualityLevel === 'LOW');
  assert.ok(explanation.actionItems.length >= 1, 'action items should be provided');
});

// ─────────────────────────────────────────────────────────────
// ANALYTICS EVENT TESTS
// ─────────────────────────────────────────────────────────────

console.log('\n── Analytics Events ──');

test('buildSignalCoverageEvaluatedEvent: produces valid event', () => {
  const event = buildSignalCoverageEvaluatedEvent({
    userId: 'user-123',
    assessmentId: 'assess-456',
    coverageResult: {
      coverageScore: 75,
      coverageLevel: 'MEDIUM',
      traitGaps: [{ trait: 'leadership' }],
      meta: { engineVersion: 'signal-coverage-v1' },
    },
  });

  assert.ok(event.eventType === 'signal_coverage_evaluated');
  assert.ok(event.dedupeKey.includes('user-123'));
  assert.strictEqual(event.payload.coverageScore, 75);
  assert.strictEqual(event.payload.traitGapCount, 1);
});

test('buildLowSignalCoverageDetectedEvent: only emits for LOW level', () => {
  const highEvent = buildLowSignalCoverageDetectedEvent({
    userId: 'user-123',
    assessmentId: 'assess-456',
    coverageResult: { coverageScore: 85, coverageLevel: 'HIGH', traitGaps: [] },
  });
  assert.strictEqual(highEvent, null, 'should not emit for HIGH coverage');

  const lowEvent = buildLowSignalCoverageDetectedEvent({
    userId: 'user-123',
    assessmentId: 'assess-456',
    coverageResult: { coverageScore: 25, coverageLevel: 'LOW', traitGaps: [] },
  });
  assert.ok(lowEvent !== null, 'should emit for LOW coverage');
  assert.strictEqual(lowEvent.eventType, 'low_signal_coverage_detected');
});

test('buildClusterDriftDetectedEvent: only emits for non-None drift', () => {
  const noEvent = buildClusterDriftDetectedEvent({
    userId: 'user-123',
    driftResult: { driftLevel: 'None', meta: {} },
  });
  assert.strictEqual(noEvent, null, 'should not emit for None drift');

  const driftEvent = buildClusterDriftDetectedEvent({
    userId: 'user-123',
    driftResult: {
      driftLevel:               'Moderate',
      driftScore:               25,
      clusterSwapped:           true,
      previousPrimaryCluster:   { clusterId: 'communicator' },
      currentPrimaryCluster:    { clusterId: 'strategic' },
      meta: { previousAssessmentId: 'a1', currentAssessmentId: 'a2' },
    },
  });
  assert.ok(driftEvent !== null, 'should emit for Moderate drift');
  assert.strictEqual(driftEvent.payload.clusterSwapped, true);
});

test('buildReliabilityThresholdCrossedEvent: only emits on upward transition', () => {
  const downward = buildReliabilityThresholdCrossedEvent({
    userId: 'u1', assessmentId: 'a1', traitKey: 'comm',
    previousLevel: 'HIGH', currentLevel: 'LOW', reliabilityScore: 30,
  });
  assert.strictEqual(downward, null, 'downward transition should not emit');

  const upward = buildReliabilityThresholdCrossedEvent({
    userId: 'u1', assessmentId: 'a1', traitKey: 'comm',
    previousLevel: 'LOW', currentLevel: 'HIGH', reliabilityScore: 85,
  });
  assert.ok(upward !== null, 'upward transition should emit');
  assert.strictEqual(upward.payload.currentLevel, 'HIGH');
});

// ─────────────────────────────────────────────────────────────
// REPORT
// ─────────────────────────────────────────────────────────────

console.log(`\n── Results: ${passed} passed, ${failed} failed ──\n`);

if (failed > 0) {
  process.exit(1);
}
