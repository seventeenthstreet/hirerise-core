'use strict';

/**
 * intelligence-quality.service.js
 *
 * Phase 4A — Intelligence Quality Service
 *
 * Coordinates the two new pipeline stages:
 *   1. Signal Coverage Evaluation  (post signal-normalization)
 *   2. Cluster Stability Evaluation (post capability-clustering)
 *
 * This service is the single entry point for the intelligence quality
 * layer. It wires together the four pure models and emits analytics.
 *
 * Architecture constraints:
 *   - Preserves API → Hooks → UI → Pages boundary
 *   - Does NOT alter any raw signal values or cluster scores
 *   - Does NOT orchestrate recommendations — quality layer only
 *   - Deterministic: same inputs → same outputs
 *   - All persistence is injection-based (repository pattern)
 *   - Analytics adapter is injected, never imported directly
 */

const { evaluateSignalCoverage }     = require('./models/signal-coverage.model');
const { evaluateSignalReliability }  = require('./models/signal-reliability.model');
const { evaluateClusterStability }   = require('./models/cluster-stability.model');
const { evaluateClusterDrift, evaluateLongitudinalDrift } = require('./models/cluster-drift.model');
const { evaluateSignalSparsity }     = require('./models/signal-sparsity.model');
const {
  explainSignalCoverage,
  explainSignalReliability,
  explainClusterStability,
  explainClusterDrift,
  explainAssessmentQuality,
} = require('./models/intelligence-quality.explainability');
const {
  buildSignalCoverageEvaluatedEvent,
  buildLowSignalCoverageDetectedEvent,
  buildClusterStabilityUpdatedEvent,
  buildClusterDriftDetectedEvent,
  buildReassessmentCompletedEvent,
  buildReliabilityThresholdCrossedEvent,
  emitIntelligenceQualityEvents,
} = require('./models/intelligence-quality.analytics');

class IntelligenceQualityService {
  /**
   * @param {object} deps
   * @param {object} deps.coverageRepository    — persistence for signal_coverage_profiles
   * @param {object} deps.reliabilityRepository — persistence for signal_reliability_scores
   * @param {object} deps.stabilityRepository   — persistence for cluster_stability_profiles
   * @param {object} deps.driftRepository       — persistence for cluster_drift_history
   * @param {function} deps.analyticsAdapter    — async (event) => void
   * @param {object} deps.logger
   * @param {object} [deps.config]              — optional threshold overrides
   */
  constructor({
    coverageRepository,
    reliabilityRepository,
    stabilityRepository,
    driftRepository,
    analyticsAdapter,
    logger,
    config = {},
  }) {
    this._coverageRepository    = coverageRepository;
    this._reliabilityRepository = reliabilityRepository;
    this._stabilityRepository   = stabilityRepository;
    this._driftRepository       = driftRepository;
    this._analyticsAdapter      = analyticsAdapter;
    this._logger                = logger;
    this._config                = config;
  }

  // ─────────────────────────────────────────────────────────
  // PIPELINE STAGE 1: Signal Coverage Evaluation
  // Called after signal normalization, before capability clustering
  // ─────────────────────────────────────────────────────────

  /**
   * Evaluates signal coverage for a user's current assessment session.
   *
   * @param {object} params
   * @param {string}   params.userId
   * @param {string}   params.assessmentId
   * @param {object}   params.normalizedSignals — output of signal normalization stage
   * @param {object}   params.assessmentMeta    — stages, questions, contradictions, etc.
   * @param {string[]} params.expectedTraits    — full domain trait catalogue
   *
   * @returns {Promise<SignalCoverageEvaluationOutput>}
   */
  async evaluateCoverageStage({ userId, assessmentId, normalizedSignals, assessmentMeta, expectedTraits = [] }) {
    this._logger.info('[IntelligenceQualityService] evaluateCoverageStage start', { userId, assessmentId });

    // ── 1. Evaluate coverage ────────────────────────────────
    const coverageResult = evaluateSignalCoverage({
      evaluatedTraits:          normalizedSignals.evaluatedTraits       ?? [],
      expectedTraits,
      completedStages:          assessmentMeta.completedStages          ?? 0,
      totalStages:              assessmentMeta.totalStages              ?? 1,
      abandonedStages:          assessmentMeta.abandonedStages          ?? 0,
      traitSampleCounts:        normalizedSignals.traitSampleCounts     ?? {},
      questionCategories:       assessmentMeta.questionCategories       ?? [],
      contradictoryAnswers:     assessmentMeta.contradictoryAnswers     ?? 0,
      adaptiveFollowUpTotal:    assessmentMeta.adaptiveFollowUpTotal    ?? 0,
      adaptiveFollowUpAnswered: assessmentMeta.adaptiveFollowUpAnswered ?? 0,
      config:                   this._config,
    });

    // ── 2. Evaluate reliability per trait ──────────────────
    const traitSignals       = normalizedSignals.traitSignals ?? [];
    const consistencyMap     = normalizedSignals.crossTraitConsistencyMap ?? {};
    const reliabilityResult  = evaluateSignalReliability({
      traitSignals,
      crossTraitConsistencyMap: consistencyMap,
      config: this._config,
    });

    // ── 3. Evaluate sparsity safeguards ────────────────────
    const sparsityResult = evaluateSignalSparsity({
      coverageScore:           coverageResult.coverageScore,
      coverageLevel:           coverageResult.coverageLevel,
      averageReliabilityScore: reliabilityResult.summary.averageReliabilityScore,
      evaluatedTraitCount:     coverageResult.meta.evaluatedTraitCount,
      contradictoryAnswers:    assessmentMeta.contradictoryAnswers     ?? 0,
      totalQuestionsAnswered:  assessmentMeta.totalQuestionsAnswered   ?? 0,
      completedStages:         assessmentMeta.completedStages          ?? 0,
      totalStages:             assessmentMeta.totalStages              ?? 1,
      config:                  this._config,
    });

    // ── 4. Build explainability ────────────────────────────
    const explainability = {
      coverage:   explainSignalCoverage(coverageResult),
      reliability: explainSignalReliability(reliabilityResult),
      quality:    explainAssessmentQuality({ coverageResult, reliabilityResult, sparsityResult }),
    };

    // ── 5. Persist (non-blocking — analytics-safe) ─────────
    await this._persistCoverageStage({ userId, assessmentId, coverageResult, reliabilityResult });

    // ── 6. Emit analytics events ───────────────────────────
    const events = [
      buildSignalCoverageEvaluatedEvent({ userId, assessmentId, coverageResult }),
      buildLowSignalCoverageDetectedEvent({ userId, assessmentId, coverageResult }),
    ];

    await emitIntelligenceQualityEvents(events, this._analyticsAdapter, this._logger);

    return {
      coverageResult,
      reliabilityResult,
      sparsityResult,
      explainability,
      suppressRecommendations: sparsityResult.suppressRecommendations,
    };
  }

  // ─────────────────────────────────────────────────────────
  // PIPELINE STAGE 2: Cluster Stability Evaluation
  // Called after capability clustering
  // ─────────────────────────────────────────────────────────

  /**
   * Evaluates cluster stability and drift for a user's cluster output.
   *
   * @param {object} params
   * @param {string}   params.userId
   * @param {string}   params.assessmentId
   * @param {object[]} params.currentClusters     — output of capability clustering stage
   * @param {object[]} params.historicalSnapshots — ordered assessment snapshots (oldest→newest)
   * @param {string}   [params.previousAssessmentId]
   *
   * @returns {Promise<ClusterStabilityEvaluationOutput>}
   */
  async evaluateClusterStabilityStage({
    userId,
    assessmentId,
    currentClusters         = [],
    historicalSnapshots     = [],
    previousAssessmentId    = null,
  }) {
    this._logger.info('[IntelligenceQualityService] evaluateClusterStabilityStage start', { userId, assessmentId });

    // ── 1. Build cluster histories from snapshots + current ─
    const clusterHistories = this._buildClusterHistories(historicalSnapshots, currentClusters);
    const totalAssessments = historicalSnapshots.length + 1;

    // ── 2. Evaluate stability ──────────────────────────────
    const stabilityResult = evaluateClusterStability({
      clusterHistories,
      totalAssessments,
      config: this._config,
    });

    // ── 3. Evaluate drift (if prior snapshot exists) ───────
    let driftResult = null;
    let longitudinalDrift = null;

    const previousSnapshot = historicalSnapshots.length > 0
      ? historicalSnapshots[historicalSnapshots.length - 1]
      : null;

    const currentSnapshot = this._buildCurrentSnapshot(assessmentId, currentClusters);

    if (previousSnapshot) {
      driftResult = evaluateClusterDrift({
        previousSnapshot,
        currentSnapshot,
        config: this._config,
      });
    }

    if (historicalSnapshots.length >= 2) {
      longitudinalDrift = evaluateLongitudinalDrift(
        [...historicalSnapshots, currentSnapshot],
        this._config
      );
    }

    // ── 4. Build explainability ────────────────────────────
    const stabilityExplanations = stabilityResult.clusterStabilityProfiles.map(profile => ({
      clusterId:    profile.clusterId,
      explanation:  explainClusterStability(profile),
    }));

    const driftExplanation = driftResult ? explainClusterDrift(driftResult) : null;

    // ── 5. Persist ─────────────────────────────────────────
    await this._persistStabilityStage({ userId, assessmentId, stabilityResult, driftResult });

    // ── 6. Emit analytics ──────────────────────────────────
    const events = [
      buildClusterStabilityUpdatedEvent({ userId, clusterStabilityResult: stabilityResult }),
      driftResult ? buildClusterDriftDetectedEvent({ userId, driftResult }) : null,
    ];

    if (previousAssessmentId) {
      events.push(buildReassessmentCompletedEvent({
        userId,
        currentAssessmentId:  assessmentId,
        previousAssessmentId,
        primaryClusterId:     stabilityResult.primaryCluster?.clusterId ?? null,
      }));
    }

    await emitIntelligenceQualityEvents(events, this._analyticsAdapter, this._logger);

    return {
      stabilityResult,
      driftResult,
      longitudinalDrift,
      stabilityExplanations,
      driftExplanation,
    };
  }

  // ─────────────────────────────────────────────────────────
  // FULL QUALITY REPORT (convenience — for dashboard/API use)
  // ─────────────────────────────────────────────────────────

  /**
   * Returns a combined intelligence quality report for the dashboard.
   * Reads from persistence — does not re-run scoring.
   *
   * @param {string} userId
   * @returns {Promise<IntelligenceQualityReport>}
   */
  async getQualityReport(userId) {
    const [coverageProfile, reliabilityScores, stabilityProfiles, latestDrift] =
      await Promise.all([
        this._coverageRepository.getLatest(userId),
        this._reliabilityRepository.getLatestByUser(userId),
        this._stabilityRepository.getLatestByUser(userId),
        this._driftRepository.getLatest(userId),
      ]);

    return {
      coverage:    coverageProfile  ?? null,
      reliability: reliabilityScores ?? [],
      stability:   stabilityProfiles ?? [],
      drift:       latestDrift       ?? null,
    };
  }

  /**
   * Returns the latest coverage profile only.
   * @param {string} userId
   */
  async getCoverageProfile(userId) {
    return this._coverageRepository.getLatest(userId);
  }

  /**
   * Returns all latest cluster stability profiles for the user.
   * @param {string} userId
   */
  async getStabilityProfiles(userId) {
    return this._stabilityRepository.getLatestByUser(userId);
  }

  /**
   * Returns the latest drift event.
   * @param {string} userId
   */
  async getLatestDrift(userId) {
    return this._driftRepository.getLatest(userId);
  }

  /**
   * Returns significant drift history.
   * @param {string} userId
   */
  async getDriftHistory(userId) {
    return this._driftRepository.getSignificantEvents(userId);
  }

  // ─────────────────────────────────────────────────────────
  // PRIVATE — PERSISTENCE
  // ─────────────────────────────────────────────────────────

  async _persistCoverageStage({ userId, assessmentId, coverageResult, reliabilityResult }) {
    try {
      await this._coverageRepository.insert({
        userId,
        assessmentId,
        coverageScore:  coverageResult.coverageScore,
        coverageLevel:  coverageResult.coverageLevel,
        factors:        coverageResult.factors,
        traitGaps:      coverageResult.traitGaps,
        coverageNotes:  coverageResult.coverageNotes,
        engineVersion:  coverageResult.meta.engineVersion,
        evaluatedAt:    coverageResult.meta.evaluatedAt,
      });

      // Persist per-trait reliability scores
      const traitInserts = reliabilityResult.traitReliabilityProfiles.map(p => ({
        userId,
        assessmentId,
        traitKey:         p.traitKey,
        rawScore:         p.rawScore,
        reliabilityScore: p.reliabilityScore,
        reliabilityLevel: p.reliabilityLevel,
        factors:          p.factors,
        sampleCount:      p.meta.sampleCount,
        lastAssessedAt:   p.meta.lastAssessedAt,
        engineVersion:    reliabilityResult.meta.engineVersion,
      }));

      await this._reliabilityRepository.insertMany(traitInserts);
    } catch (err) {
      this._logger.warn('[IntelligenceQualityService] Coverage persistence failed', {
        error: err?.message ?? 'Unknown error',
        userId,
        assessmentId,
      });
      // Persistence failures must not break the pipeline
    }
  }

  async _persistStabilityStage({ userId, assessmentId, stabilityResult, driftResult }) {
    try {
      const stabilityInserts = stabilityResult.clusterStabilityProfiles.map(p => ({
        userId,
        clusterId:       p.clusterId,
        clusterLabel:    p.clusterLabel,
        stabilityScore:  p.stabilityScore,
        stabilityLevel:  p.stabilityLevel,
        trendDirection:  p.trendDirection,
        appearanceCount: p.appearanceCount,
        averageScore:    p.averageScore,
        lastScore:       p.lastScore,
        factors:         p.factors,
        totalAssessments: stabilityResult.meta.totalAssessments,
        firstSeenAt:     p.meta.firstSeenAt,
        lastSeenAt:      p.meta.lastSeenAt,
        engineVersion:   stabilityResult.meta.engineVersion,
        evaluatedAt:     stabilityResult.meta.evaluatedAt,
      }));

      await this._stabilityRepository.insertMany(stabilityInserts);

      if (driftResult && driftResult.driftLevel !== 'None') {
        await this._driftRepository.insert({
          userId,
          previousAssessmentId:    driftResult.meta.previousAssessmentId,
          currentAssessmentId:     driftResult.meta.currentAssessmentId,
          previousAssessedAt:      driftResult.meta.previousAssessedAt,
          currentAssessedAt:       driftResult.meta.currentAssessedAt,
          driftScore:              driftResult.driftScore,
          driftLevel:              driftResult.driftLevel,
          clusterSwapped:          driftResult.clusterSwapped,
          primaryScoreDelta:       driftResult.primaryScoreDelta,
          previousPrimaryClusterId: driftResult.previousPrimaryCluster?.clusterId ?? null,
          previousPrimaryLabel:     driftResult.previousPrimaryCluster?.clusterLabel ?? null,
          currentPrimaryClusterId:  driftResult.currentPrimaryCluster?.clusterId ?? null,
          currentPrimaryLabel:      driftResult.currentPrimaryCluster?.clusterLabel ?? null,
          clusterDeltas:            driftResult.clusterDeltas,
          explanation:              driftResult.explanation,
          engineVersion:            driftResult.meta.engineVersion,
        });
      }
    } catch (err) {
      this._logger.warn('[IntelligenceQualityService] Stability persistence failed', {
        error: err?.message ?? 'Unknown error',
        userId,
        assessmentId,
      });
    }
  }

  // ─────────────────────────────────────────────────────────
  // PRIVATE — HELPERS
  // ─────────────────────────────────────────────────────────

  /**
   * Rebuilds ClusterHistory[] structures from snapshot history + current clusters.
   * Groups appearances by clusterId across all historical assessments.
   */
  _buildClusterHistories(snapshots, currentClusters) {
    const historyMap = new Map();

    // Process historical snapshots
    for (const snapshot of snapshots) {
      for (const cluster of snapshot.allClusters ?? []) {
        if (!historyMap.has(cluster.clusterId)) {
          historyMap.set(cluster.clusterId, {
            clusterId:    cluster.clusterId,
            clusterLabel: cluster.clusterLabel ?? cluster.clusterId,
            appearances:  [],
          });
        }

        historyMap.get(cluster.clusterId).appearances.push({
          assessmentId: snapshot.assessmentId,
          assessedAt:   snapshot.assessedAt,
          clusterScore: cluster.score  ?? 0,
          clusterRank:  cluster.rank   ?? 99,
        });
      }
    }

    // Add current assessment clusters
    for (const cluster of currentClusters) {
      if (!historyMap.has(cluster.clusterId)) {
        historyMap.set(cluster.clusterId, {
          clusterId:    cluster.clusterId,
          clusterLabel: cluster.clusterLabel ?? cluster.clusterId,
          appearances:  [],
        });
      }

      historyMap.get(cluster.clusterId).appearances.push({
        assessmentId: 'current',
        assessedAt:   new Date().toISOString(),
        clusterScore: cluster.score ?? 0,
        clusterRank:  cluster.rank  ?? 99,
      });
    }

    return Array.from(historyMap.values());
  }

  /**
   * Builds an AssessmentSnapshot from current cluster output.
   */
  _buildCurrentSnapshot(assessmentId, currentClusters) {
    const sorted     = [...currentClusters].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const primary    = sorted[0] ?? null;

    return {
      assessmentId,
      assessedAt:     new Date().toISOString(),
      primaryCluster: primary
        ? { clusterId: primary.clusterId, clusterLabel: primary.clusterLabel, score: primary.score }
        : null,
      allClusters: currentClusters.map((c, i) => ({
        clusterId:    c.clusterId,
        clusterLabel: c.clusterLabel,
        score:        c.score ?? 0,
        rank:         c.rank  ?? i + 1,
      })),
    };
  }
}

module.exports = IntelligenceQualityService;
