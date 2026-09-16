'use strict';

/**
 * src/modules/student-onboarding/services/intelligence.service.js
 *
 * Phase 3D — Cross-Domain Intelligence Layer
 * INTELLIGENCE AGGREGATION SERVICE
 *
 * PURPOSE:
 *   Orchestrates the full cross-domain signal aggregation pipeline for a student.
 *   Called after onboarding completion (or on-demand for diagnostics).
 *
 * PIPELINE (in order):
 *   1. Load raw domain data from existing Phase 3A/3B/3C tables.
 *   2. Normalize each domain into SignalContribution[].
 *   3. Deduplicate new contributions against existing evidence records.
 *   4. Aggregate into CrossDomainSignalBundle.
 *   5. Persist:
 *      a. student_signal_evidence (append-only, deduplicated)
 *      b. student_signal_vectors  (upsert)
 *      c. signal_confidence_models (upsert)
 *   6. Return the bundle to the caller.
 *
 * CRITICAL RULES:
 *   ✗ DO NOT generate recommendations, scores, or career predictions.
 *   ✗ DO NOT overwrite raw domain data.
 *   ✓ All writes are safe to retry (deduplication + upsert).
 *   ✓ Errors in individual domain normalization are logged but do not
 *     abort the pipeline — partial bundles are valid.
 */

const logger = require('../../../../shared/logger');
const {
  SignalRegistryRepository,
  StudentSignalVectorRepository,
  StudentSignalEvidenceRepository,
  SignalConfidenceRepository,
} = require('../repositories/intelligence.repository');

const { aggregateCrossDomainSignals }  = require('../signals/cross-domain.aggregator');
const {
  normalizeAcademicSignals,
  normalizeActivitySignals,
  normalizeCognitiveSignals,
  normalizeReflectionSignals,
  normalizeAspirationSignals,
} = require('../signals/domain-normalizers');
const { buildSignalBundle }            = require('../signals/activity.signals');
const { buildCognitiveSignalBundle }   = require('../signals/cognitive.signals');
const { AGGREGATION_VERSION }          = require('../constants/intelligence');

// ─────────────────────────────────────────────────────────────────────────────
// PURE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Filters a raw student_activities row list down to committed
 * (is_partial === false) rows only — the same "committed records only"
 * convention already used by academic year evidence (Phase 3B.2) and by
 * activity.repository.js#fetchActivitySignalQuality's committedCount.
 * Extracted as a pure, independently-testable function (Phase 3B.3).
 *
 * @param {Object[]} activities  — raw student_activities rows
 * @returns {Object[]}
 */
function filterCommittedActivities(activities) {
  if (!Array.isArray(activities)) return [];
  return activities.filter((a) => a?.is_partial !== true);
}

// ─────────────────────────────────────────────────────────────────────────────
// REPOSITORY INSTANCES
// ─────────────────────────────────────────────────────────────────────────────

const signalRegistry   = new SignalRegistryRepository();
const vectorRepo       = new StudentSignalVectorRepository();
const evidenceRepo     = new StudentSignalEvidenceRepository();
const confidenceRepo   = new SignalConfidenceRepository();

// ─────────────────────────────────────────────────────────────────────────────
// MAIN PIPELINE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs the full cross-domain intelligence aggregation pipeline for a student.
 *
 * @param {string} userId
 * @param {Object} rawDomainData
 * @param {Object}   rawDomainData.academics  — { years: Record<string, Object> } — the
 *   year-map shape returned by academic.repository.js#groupAcademicData(records, subjects)
 * @param {Object}   rawDomainData.activities — { activities: Object[], achievements: Object[], reflection: Object|null }
 * @param {Object}   rawDomainData.cognitive  — { responses: Object[], taxonomyRows: Object[] }
 * @param {Object}   [rawDomainData.aspiration] — Phase 3B.5B: the canonical
 *   student_aspirations row — { career_interests: string[],
 *   motivation_driver: string|null, time_horizon: string|null }. This is
 *   unrelated to, and must not be confused with, the legacy
 *   rawDomainData.activities.reflection / rawDomainData.aspiration.reflection
 *   activity-reflection concept still read further below — that is a
 *   separate, pre-existing path keyed off student_activity_reflections,
 *   not student_aspirations.
 * @param {Object}   [options]
 * @param {boolean}  [options.dryRun]  — if true, aggregate but do not persist
 * @param {string}   [options.pipelineRunId]
 * @returns {Promise<{
 *   bundle:          CrossDomainSignalBundle,
 *   evidenceInserted: number,
 *   vectorId:        string|null,
 *   confidenceRows:  number,
 *   dryRun:          boolean,
 * }>}
 */
async function runIntelligencePipeline(userId, rawDomainData, options = {}) {
  const { dryRun = false, pipelineRunId = `run_${Date.now()}` } = options;

  logger.info('intelligence_pipeline.start', { userId, pipelineRunId, dryRun });

  // ── Step 1: Normalize each domain ─────────────────────────────────────────

  const domainContributions = {
    academic:   [],
    activity:   [],
    cognitive:  [],
    aspiration: [],
  };

  // Academic normalization
  //
  // Phase 3B.2: rawDomainData.academics.years is the real Student v2 shape —
  // the year-map produced by academic.repository.js#groupAcademicData(). The
  // previous `academicYears` array shape (with subject_snapshots/current_band)
  // never matched the actual schema; see the Phase 3B.1/3B.2 checkpoint
  // report for details. This is a data-shape correction only — it does not
  // change how the caller (currently only intelligence.controller.js's
  // admin-only triggerPipeline, which has its own separate, pre-existing,
  // out-of-scope defect — see checkpoint report §"Deferred Findings") loads
  // the underlying records.
  try {
    if (rawDomainData.academics?.years && Object.keys(rawDomainData.academics.years).length > 0) {
      domainContributions.academic = normalizeAcademicSignals(
        userId,
        rawDomainData.academics.years,
      );
      logger.info('intelligence_pipeline.academic_normalized', {
        userId,
        count: domainContributions.academic.length,
      });
    }
  } catch (err) {
    logger.warn('intelligence_pipeline.academic_normalization_failed', {
      userId,
      message: err.message,
    });
    // Continue with empty academic contributions — partial bundle is valid
  }

  // Activity normalization
  //
  // Phase 3B.3: only committed (is_partial === false) activities are signal
  // sources — mirrors the existing "committed records only" convention
  // already established for academic years (Phase 3B.2) and already used
  // for onboarding-completeness purposes by
  // activity.repository.js#fetchActivitySignalQuality (committedCount =
  // activities.filter(a => !a.is_partial)). Previously this filter was
  // missing entirely from the signal-derivation path — an in-progress
  // "activity just added to the list, depth details not yet filled in" row
  // could silently contribute signal evidence. reflection/category lookup
  // still uses the full (unfiltered) activity list — a reflection is a
  // statement about the student's own intent, not a claim about that
  // activity's recorded performance data, so partial-row completeness
  // doesn't bear on it the same way.
  try {
    const allActivities = rawDomainData.activities?.activities ?? [];
    const committedActivities = filterCommittedActivities(allActivities);

    if (committedActivities.length > 0) {
      const activityBundle = buildSignalBundle(
        committedActivities,
        rawDomainData.activities.achievements ?? [],
      );
      domainContributions.activity = normalizeActivitySignals(userId, activityBundle.envelopes);

      // Reflection signals (aspiration step or activity reflection)
      const reflection = rawDomainData.activities.reflection ?? rawDomainData.aspiration?.reflection;
      if (reflection) {
        const activityCategoryMap = Object.fromEntries(
          allActivities.map((a) => [a.activity_key, a.activity_category]),
        );
        const reflectionContributions = normalizeReflectionSignals(
          userId, reflection, activityCategoryMap,
        );
        domainContributions.activity.push(...reflectionContributions);
      }

      logger.info('intelligence_pipeline.activity_normalized', {
        userId,
        count: domainContributions.activity.length,
      });
    }
  } catch (err) {
    logger.warn('intelligence_pipeline.activity_normalization_failed', {
      userId,
      message: err.message,
    });
  }

  // Cognitive normalization
  try {
    if (
      rawDomainData.cognitive?.responses?.length > 0 &&
      rawDomainData.cognitive?.taxonomyRows?.length > 0
    ) {
      const cognitiveBundle = buildCognitiveSignalBundle(
        rawDomainData.cognitive.responses,
        rawDomainData.cognitive.taxonomyRows,
      );
      domainContributions.cognitive = normalizeCognitiveSignals(userId, cognitiveBundle);
      logger.info('intelligence_pipeline.cognitive_normalized', {
        userId,
        count: domainContributions.cognitive.length,
      });
    }
  } catch (err) {
    logger.warn('intelligence_pipeline.cognitive_normalization_failed', {
      userId,
      message: err.message,
    });
  }

  // Aspiration normalization — Phase 3B.5B
  //
  // Canonical source: student_aspirations (career_interests,
  // motivation_driver only). time_horizon is intentionally never passed
  // into the normalizer — it remains contextual metadata only per the
  // Phase 3B.5B.0 contract and must never become a signal. This is a
  // dedicated, first-class Family #1 domain — separate from, and never
  // fed by, the legacy activities-reflection path above.
  try {
    const aspirationRow = rawDomainData.aspiration;
    if (
      (Array.isArray(aspirationRow?.career_interests) && aspirationRow.career_interests.length > 0) ||
      aspirationRow?.motivation_driver
    ) {
      domainContributions.aspiration = normalizeAspirationSignals(userId, aspirationRow);
      logger.info('intelligence_pipeline.aspiration_normalized', {
        userId,
        count: domainContributions.aspiration.length,
      });
    }
  } catch (err) {
    logger.warn('intelligence_pipeline.aspiration_normalization_failed', {
      userId,
      message: err.message,
    });
    // Continue with empty aspiration contributions — partial bundle is valid
  }

  // ── Step 2: Aggregate ──────────────────────────────────────────────────────

  const bundle = aggregateCrossDomainSignals(userId, domainContributions, pipelineRunId);

  logger.info('intelligence_pipeline.aggregated', {
    userId,
    pipelineRunId,
    signalCount:       Object.keys(bundle.signal_weights).length,
    domainsIncluded:   bundle.domains_included,
    isCompleteVector:  bundle.is_complete_vector,
    contradictionCount: Object.keys(bundle.contradiction_metadata).length,
  });

  if (dryRun) {
    logger.info('intelligence_pipeline.dry_run_complete', { userId });
    return { bundle, evidenceInserted: 0, vectorId: null, confidenceRows: 0, dryRun: true };
  }

  // ── Step 3: Deduplication — skip already-recorded evidence ────────────────

  const allContributions = [
    ...domainContributions.academic,
    ...domainContributions.activity,
    ...domainContributions.cognitive,
    ...domainContributions.aspiration,
  ];

  const existingKeys   = await evidenceRepo.getExistingReferenceKeys(userId, AGGREGATION_VERSION);
  const newContributions = allContributions.filter((c) => {
    const key = `${c.signal_key}__${c.source_reference_id}__${c.aggregation_version ?? AGGREGATION_VERSION}`;
    return !existingKeys.has(key);
  });

  logger.info('intelligence_pipeline.evidence_dedup', {
    userId,
    total:     allContributions.length,
    existing:  existingKeys.size,
    new:       newContributions.length,
  });

  // ── Step 4: Persist evidence (append-only) ─────────────────────────────────

  let evidenceInserted = 0;
  if (newContributions.length > 0) {
    evidenceInserted = await evidenceRepo.bulkInsertEvidence(userId, newContributions);
    logger.info('intelligence_pipeline.evidence_inserted', { userId, evidenceInserted });
  }

  // ── Step 5: Upsert signal vector ──────────────────────────────────────────

  const vectorId = await vectorRepo.upsertVector(userId, bundle);
  logger.info('intelligence_pipeline.vector_upserted', { userId, vectorId });

  // ── Step 6: Upsert confidence models ──────────────────────────────────────

  const confidenceRows = await confidenceRepo.upsertBundleConfidence(userId, bundle);
  logger.info('intelligence_pipeline.confidence_upserted', { userId, confidenceRows });

  logger.info('intelligence_pipeline.complete', {
    userId,
    pipelineRunId,
    evidenceInserted,
    vectorId,
    confidenceRows,
  });

  return { bundle, evidenceInserted, vectorId, confidenceRows, dryRun: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// QUERY METHODS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the current signal vector for a user.
 *
 * @param {string} userId
 * @returns {Promise<Object|null>}
 */
async function getStudentVector(userId) {
  return vectorRepo.findByUser(userId, AGGREGATION_VERSION);
}

/**
 * Returns confidence models for all signals for a user.
 *
 * @param {string} userId
 * @returns {Promise<Object[]>}
 */
async function getStudentConfidence(userId) {
  return confidenceRepo.findByUser(userId, AGGREGATION_VERSION);
}

/**
 * Returns evidence records for a specific signal, for diagnostics.
 *
 * @param {string} userId
 * @param {string} signalKey
 * @returns {Promise<Object[]>}
 */
async function getSignalEvidence(userId, signalKey) {
  return evidenceRepo.findByUserAndSignal(userId, signalKey);
}

/**
 * Returns the full active signal registry.
 * Used by validators and the diagnostics controller.
 *
 * @returns {Promise<Object[]>}
 */
async function getSignalRegistry() {
  return signalRegistry.findAllActive();
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  runIntelligencePipeline,
  getStudentVector,
  getStudentConfidence,
  getSignalEvidence,
  getSignalRegistry,

  // Exposed for testing (Phase 3B.3)
  filterCommittedActivities,
};
