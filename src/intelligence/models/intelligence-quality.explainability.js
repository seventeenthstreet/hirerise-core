'use strict';

/**
 * intelligence-quality.explainability.js
 *
 * Explainability extensions for Phase 4A intelligence quality systems.
 *
 * Generates human-readable explanations for:
 *   1. Signal coverage
 *   2. Signal reliability
 *   3. Cluster stability
 *   4. Cluster drift
 *   5. Assessment quality
 *
 * Pure domain model:
 *   - database agnostic
 *   - no side effects
 *   - deterministic output
 *   - governance-safe
 */

// ─────────────────────────────────────────────────────────────
// 1. SIGNAL COVERAGE EXPLAINABILITY
// ─────────────────────────────────────────────────────────────

/**
 * @param {object} coverageResult — from evaluateSignalCoverage()
 * @returns {{ headline: string, detail: string, notes: string[] }}
 */
function explainSignalCoverage(coverageResult = {}) {
  const level = coverageResult.coverageLevel ?? 'LOW';
  const score = coverageResult.coverageScore ?? 0;
  const notes = coverageResult.coverageNotes ?? [];
  const gaps  = coverageResult.traitGaps     ?? [];

  const headlines = {
    HIGH:   'Your assessment profile has strong signal coverage.',
    MEDIUM: 'Your assessment profile has moderate signal coverage.',
    LOW:    'Your assessment profile needs more data for reliable recommendations.',
  };

  const detailParts = [];

  if (level === 'HIGH') {
    detailParts.push(
      'You have completed enough assessment stages and trait areas to give us high confidence in your profile.'
    );
  } else if (level === 'MEDIUM') {
    const missingSections = gaps
      .filter(g => g.reason === 'not_assessed')
      .map(g => g.trait)
      .slice(0, 3);

    if (missingSections.length) {
      detailParts.push(
        `Some trait areas — such as ${missingSections.join(', ')} — require more assessment data for stronger confidence.`
      );
    } else {
      detailParts.push(
        'A few assessment areas need additional responses to strengthen your profile coverage.'
      );
    }
  } else {
    detailParts.push(
      'Your assessment is still in early stages. Completing more of your assessment will significantly improve the quality of your recommendations.'
    );
  }

  return {
    headline: headlines[level] ?? headlines.LOW,
    score:    score,
    level:    level,
    detail:   detailParts.join(' '),
    notes,
  };
}

// ─────────────────────────────────────────────────────────────
// 2. SIGNAL RELIABILITY EXPLAINABILITY
// ─────────────────────────────────────────────────────────────

/**
 * @param {object} reliabilityResult — from evaluateSignalReliability()
 * @returns {{ headline: string, detail: string, unreliableTraitSummary: string|null }}
 */
function explainSignalReliability(reliabilityResult = {}) {
  const summary  = reliabilityResult.summary ?? {};
  const level    = summary.overallReliabilityLevel ?? 'LOW';
  const avgScore = summary.averageReliabilityScore ?? 0;
  const unreliableTraits = summary.unreliableTraits ?? [];

  const headlines = {
    HIGH:   'Your capability signals have high reliability.',
    MEDIUM: 'Your capability signals have moderate reliability.',
    LOW:    'Some capability signals need more confirmation.',
  };

  const detailParts = [];

  if (level === 'HIGH') {
    detailParts.push(
      'Your assessment responses are consistent and backed by sufficient data — ' +
      'we have strong confidence in each capability score shown.'
    );
  } else if (level === 'MEDIUM') {
    detailParts.push(
      'Most capability areas have been confirmed with enough data. ' +
      'Completing additional assessment questions will move more traits into the high-reliability band.'
    );
  } else {
    detailParts.push(
      'Several capability areas do not yet have enough assessment data for us to confirm your scores with high confidence. ' +
      'Reassessing these areas will improve accuracy.'
    );
  }

  let unreliableTraitSummary = null;
  if (unreliableTraits.length) {
    const traitList = unreliableTraits.slice(0, 4).map(t => t.traitKey).join(', ');
    unreliableTraitSummary =
      `Lower-reliability areas: ${traitList}${unreliableTraits.length > 4 ? ' and others' : ''}.`;
  }

  return {
    headline:               headlines[level] ?? headlines.LOW,
    score:                  avgScore,
    level,
    detail:                 detailParts.join(' '),
    unreliableTraitSummary,
  };
}

// ─────────────────────────────────────────────────────────────
// 3. CLUSTER STABILITY EXPLAINABILITY
// ─────────────────────────────────────────────────────────────

/**
 * @param {object} stabilityProfile — single cluster from evaluateClusterStability()
 * @returns {{ headline: string, detail: string }}
 */
function explainClusterStability(stabilityProfile = {}) {
  const label          = stabilityProfile.clusterLabel   ?? 'This cluster';
  const level          = stabilityProfile.stabilityLevel ?? 'UNSTABLE';
  const appearanceCount = stabilityProfile.appearanceCount ?? 0;
  const trendDirection = stabilityProfile.trendDirection ?? 'STABLE';

  const trendDescriptions = {
    RISING:   'recently strengthened significantly',
    DECLINING: 'recently decreased somewhat',
    STABLE:   'remained consistent',
  };

  const trendDesc = trendDescriptions[trendDirection] ?? 'changed';

  let headline;
  let detail;

  if (level === 'HIGH') {
    headline = `${label}: High Stability`;
    detail   =
      `Your ${label} profile has ${trendDesc} and been observed consistently across ` +
      `${appearanceCount} assessment${appearanceCount !== 1 ? 's' : ''}. ` +
      `This is a core part of your capability identity.`;
  } else if (level === 'EMERGING') {
    headline = `${label}: Emerging`;
    detail   =
      `Your ${label} profile is ${trendDesc}. ` +
      `It has appeared in ${appearanceCount} assessment${appearanceCount !== 1 ? 's' : ''} ` +
      `and may become a more prominent part of your profile over time.`;
  } else {
    headline = `${label}: Unstable`;
    detail   =
      `Your ${label} profile is not yet consistent across assessments. ` +
      `Further assessment will help establish whether this is a reliable part of your profile.`;
  }

  return { headline, level, detail, trendDirection };
}

// ─────────────────────────────────────────────────────────────
// 4. CLUSTER DRIFT EXPLAINABILITY
// ─────────────────────────────────────────────────────────────

/**
 * @param {object} driftResult — from evaluateClusterDrift()
 * @returns {{ headline: string, detail: string, possibleCauses: string[] }}
 */
function explainClusterDrift(driftResult = {}) {
  const level        = driftResult.driftLevel        ?? 'None';
  const swapped      = driftResult.clusterSwapped    ?? false;
  const prevCluster  = driftResult.previousPrimaryCluster ?? {};
  const currCluster  = driftResult.currentPrimaryCluster  ?? {};
  const clusterDeltas = driftResult.clusterDeltas    ?? [];
  const explanation  = driftResult.explanation       ?? '';

  let headline;

  if (level === 'None') {
    headline = 'Your capability profile is consistent with your previous assessment.';
  } else if (swapped) {
    headline =
      `Your primary capability area has shifted from "${prevCluster.clusterLabel ?? 'previous'}" ` +
      `to "${currCluster.clusterLabel ?? 'current'}".`;
  } else {
    const direction = (driftResult.primaryScoreDelta ?? 0) > 0 ? 'strengthened' : 'changed';
    headline = `Your "${currCluster.clusterLabel ?? 'primary'}" capability has ${direction} since your last assessment.`;
  }

  // Identify rising areas as possible causes
  const risingAreas = clusterDeltas
    .filter(d => d.scoreDelta !== null && d.scoreDelta >= 8)
    .map(d => d.clusterLabel)
    .filter(Boolean);

  const possibleCauses = risingAreas.length
    ? [`Improved signals in: ${risingAreas.join(', ')}`]
    : [];

  return {
    headline,
    level,
    detail:        explanation,
    possibleCauses,
  };
}

// ─────────────────────────────────────────────────────────────
// 5. ASSESSMENT QUALITY EXPLAINABILITY
// ─────────────────────────────────────────────────────────────

/**
 * Consolidates coverage + reliability + sparsity into a single
 * assessment quality narrative.
 *
 * @param {object} params
 * @param {object} params.coverageResult
 * @param {object} params.reliabilityResult
 * @param {object} params.sparsityResult
 * @returns {{ qualityLevel: string, headline: string, detail: string, actionItems: string[] }}
 */
function explainAssessmentQuality({ coverageResult = {}, reliabilityResult = {}, sparsityResult = {} }) {
  const coverageLevel     = coverageResult.coverageLevel                        ?? 'LOW';
  const reliabilityLevel  = reliabilityResult.summary?.overallReliabilityLevel  ?? 'LOW';
  const sparsityLevel     = sparsityResult.sparsityLevel                        ?? 'NONE';
  const suppressed        = sparsityResult.suppressRecommendations              ?? false;

  // Compute overall quality level
  const levels    = ['HIGH', 'MEDIUM', 'LOW'];
  const levelRank = (l) => levels.indexOf(l.toUpperCase());

  const coverageRank    = levelRank(coverageLevel);
  const reliabilityRank = levelRank(reliabilityLevel);
  const worstRank       = Math.max(coverageRank, reliabilityRank);
  const qualityLevel    = levels[Math.min(worstRank, 2)];

  let headline;
  const actionItems = [];

  if (suppressed) {
    headline = 'Your assessment needs more data before we can generate recommendations.';
    actionItems.push('Complete additional assessment stages to improve coverage.');
  } else if (qualityLevel === 'HIGH') {
    headline = 'Your assessment quality is strong — your results are highly reliable.';
  } else if (qualityLevel === 'MEDIUM') {
    headline = 'Your assessment quality is good — results are reliable with some room for improvement.';
    actionItems.push('Completing more assessment stages will increase your profile confidence.');
  } else {
    headline = 'Your assessment quality needs improvement — some results may be less reliable.';
    actionItems.push('Complete all assessment stages for accurate recommendations.');
    actionItems.push('Review and confirm any contradictory responses.');
  }

  const warningActions = (sparsityResult.warningFlags ?? []).map(w => {
    switch (w.reason) {
      case 'HIGH_CONTRADICTION_RATE':
        return 'Review assessment questions where your answers may be inconsistent.';
      case 'HIGH_ABANDONMENT_RATE':
        return 'Return to and complete your incomplete assessment stages.';
      default:
        return null;
    }
  }).filter(Boolean);

  const allActions = [...new Set([...actionItems, ...warningActions])];

  const detailParts = [];
  detailParts.push(`Signal coverage: ${coverageLevel.toLowerCase()}.`);
  detailParts.push(`Signal reliability: ${reliabilityLevel.toLowerCase()}.`);

  if (sparsityLevel !== 'NONE') {
    detailParts.push(sparsityResult.userFacingWarning ?? '');
  }

  return {
    qualityLevel,
    headline,
    detail:      detailParts.filter(Boolean).join(' '),
    actionItems: allActions,
  };
}

module.exports = {
  explainSignalCoverage,
  explainSignalReliability,
  explainClusterStability,
  explainClusterDrift,
  explainAssessmentQuality,
};
