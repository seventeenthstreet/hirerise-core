'use strict';

/**
 * src/modules/student-onboarding/controllers/intelligence.controller.js
 *
 * Phase 3D — Cross-Domain Intelligence Layer
 * INTELLIGENCE DIAGNOSTICS CONTROLLER
 *
 * PURPOSE:
 *   Thin HTTP layer over intelligence.service.js.
 *   Exposes internal diagnostic endpoints for admin/dev use ONLY.
 *
 * CRITICAL RULES:
 *   ✗ DO NOT expose student-facing endpoints here.
 *   ✗ DO NOT expose recommendation outputs.
 *   ✗ DO NOT expose raw evidence to unauthenticated callers.
 *   ✓ All routes require admin-level auth (enforced at router level).
 *   ✓ GET endpoints only — no mutations from controller layer.
 *   ✓ Pipeline trigger endpoint (POST /trigger) is admin-gated and dry-run by default.
 *
 * ROUTES (all mounted under /api/v1/intelligence — see intelligence.routes.js):
 *   GET  /registry                    — full active signal registry
 *   GET  /student/:userId/vector      — current signal vector for a student
 *   GET  /student/:userId/confidence  — confidence models for a student
 *   GET  /student/:userId/evidence/:signalKey — evidence for one signal
 *   POST /student/:userId/trigger     — trigger pipeline (admin only, dry-run default)
 */

const intelligenceService = require('../services/intelligence.service');
const academicRepo        = require('../repositories/academic.repository');
const activityRepo        = require('../repositories/activity.repository');
const cognitiveRepo       = require('../repositories/cognitive.repository');
const logger              = require('../../../../shared/logger');

// ─────────────────────────────────────────────────────────────────────────────
// GET /registry
// Returns the full active signal registry.
// ─────────────────────────────────────────────────────────────────────────────

async function getRegistry(req, res) {
  const registry = await intelligenceService.getSignalRegistry();
  res.json({ ok: true, registry, count: registry.length });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /student/:userId/vector
// Returns the current aggregated signal vector for a student.
// ─────────────────────────────────────────────────────────────────────────────

async function getStudentVector(req, res) {
  const { userId } = req.params;

  if (!userId) {
    return res.status(400).json({ ok: false, error: 'userId is required' });
  }

  const vector = await intelligenceService.getStudentVector(userId);

  if (!vector) {
    return res.status(404).json({
      ok:    false,
      error: 'No signal vector found for this user. Run the aggregation pipeline first.',
    });
  }

  res.json({ ok: true, vector });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /student/:userId/confidence
// Returns confidence model rows for all signals for a student.
// ─────────────────────────────────────────────────────────────────────────────

async function getStudentConfidence(req, res) {
  const { userId } = req.params;

  if (!userId) {
    return res.status(400).json({ ok: false, error: 'userId is required' });
  }

  const models = await intelligenceService.getStudentConfidence(userId);
  res.json({ ok: true, models, count: models.length });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /student/:userId/evidence/:signalKey
// Returns evidence records for a specific signal for a student.
// ─────────────────────────────────────────────────────────────────────────────

async function getSignalEvidence(req, res) {
  const { userId, signalKey } = req.params;

  if (!userId || !signalKey) {
    return res.status(400).json({ ok: false, error: 'userId and signalKey are required' });
  }

  const evidence = await intelligenceService.getSignalEvidence(userId, signalKey);
  res.json({ ok: true, signal_key: signalKey, evidence, count: evidence.length });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /student/:userId/trigger
// Triggers the intelligence pipeline for a student.
// Admin-only. dry_run=true by default for safety.
// ─────────────────────────────────────────────────────────────────────────────

async function triggerPipeline(req, res) {
  const { userId }  = req.params;
  const dryRun      = req.body?.dry_run !== false; // default true
  const pipelineRunId = `admin_trigger_${Date.now()}`;

  if (!userId) {
    return res.status(400).json({ ok: false, error: 'userId is required' });
  }

  logger.info('intelligence_pipeline.admin_trigger', {
    triggeredBy: req.user?.uid,
    userId,
    dryRun,
    pipelineRunId,
  });

  // Load raw domain data from existing Phase tables
  const [academicYears, activities, achievements, reflection, cognitiveResponses, taxonomyRows] =
    await Promise.all([
      _safeLoad(() => academicRepo.findYearsByUser(userId),   'academic_years',      []),
      _safeLoad(() => activityRepo.findActivitiesByUser(userId), 'activities',        []),
      _safeLoad(() => activityRepo.findAchievementsByUser(userId), 'achievements',    []),
      _safeLoad(() => activityRepo.findReflectionByUser(userId), 'reflection',        null),
      _safeLoad(() => cognitiveRepo.findResponsesByUser(userId), 'cognitive_responses', []),
      _safeLoad(() => cognitiveRepo.fetchCognitiveTaxonomy(),    'cognitive_taxonomy',  []),
    ]);

  const rawDomainData = {
    academics:  { academicYears },
    activities: { activities, achievements, reflection },
    cognitive:  { responses: cognitiveResponses, taxonomyRows },
  };

  const result = await intelligenceService.runIntelligencePipeline(
    userId,
    rawDomainData,
    { dryRun, pipelineRunId },
  );

  res.json({
    ok:               true,
    pipeline_run_id:  pipelineRunId,
    dry_run:          result.dryRun,
    evidence_inserted: result.evidenceInserted,
    vector_id:        result.vectorId,
    confidence_rows:  result.confidenceRows,
    signal_count:     Object.keys(result.bundle.signal_weights).length,
    domains_included: result.bundle.domains_included,
    is_complete:      result.bundle.is_complete_vector,
    contradictions:   Object.keys(result.bundle.contradiction_metadata).length,
    // Never include raw bundle.signal_weights in production response.
    // Include for dry-run diagnostics only.
    ...(dryRun && {
      preview: {
        signal_weights:      result.bundle.signal_weights,
        contradiction_metadata: result.bundle.contradiction_metadata,
      },
    }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

async function _safeLoad(loader, label, fallback) {
  try {
    return await loader();
  } catch (err) {
    logger.warn(`intelligence_controller.load_failed.${label}`, { message: err.message });
    return fallback;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  getRegistry,
  getStudentVector,
  getStudentConfidence,
  getSignalEvidence,
  triggerPipeline,
};
