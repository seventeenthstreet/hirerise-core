'use strict';

/**
 * controllers/platformIntelligence.controller.js
 *
 * HTTP controller for all 11 Platform Intelligence sub-modules.
 * All routes require authenticate + requireAdmin (applied in routes file).
 */

const svc    = require('../services/platformIntelligence.service');
const logger = require('../../../utils/logger');

const ok  = (res, data, status = 200) => res.status(status).json({ success: true, data });
const fail = (res, next, err, label)  => {
  logger.error({ err: err.message }, `[PI] ${label}`);
  if (err.statusCode) return res.status(err.statusCode).json({ success: false, error: err.message });
  return next(err);
};

// ─── 1. AI Settings ──────────────────────────────────────────────────────────

exports.getAISettings    = async (req, res, next) => {
  try { ok(res, await svc.getAISettings()); } catch (e) { fail(res, next, e, 'getAISettings'); }
};
exports.upsertAISettings = async (req, res, next) => {
  try { ok(res, await svc.upsertAISettings(req.body)); } catch (e) { fail(res, next, e, 'upsertAISettings'); }
};

// ─── 2. Market Data Sources ───────────────────────────────────────────────────

exports.listMarketSources   = async (req, res, next) => {
  try { ok(res, await svc.listMarketSources()); } catch (e) { fail(res, next, e, 'listMarketSources'); }
};
exports.createMarketSource  = async (req, res, next) => {
  try { ok(res, await svc.createMarketSource(req.body), 201); } catch (e) { fail(res, next, e, 'createMarketSource'); }
};
exports.updateMarketSource  = async (req, res, next) => {
  try { ok(res, await svc.updateMarketSource(req.params.id, req.body)); } catch (e) { fail(res, next, e, 'updateMarketSource'); }
};
exports.deleteMarketSource  = async (req, res, next) => {
  try { await svc.deleteMarketSource(req.params.id); ok(res, { deleted: true }); } catch (e) { fail(res, next, e, 'deleteMarketSource'); }
};

// ─── 3. Career Datasets ───────────────────────────────────────────────────────

exports.listCareerDatasets   = async (req, res, next) => {
  try { ok(res, await svc.listCareerDatasets()); } catch (e) { fail(res, next, e, 'listCareerDatasets'); }
};
exports.createCareerDataset  = async (req, res, next) => {
  try { ok(res, await svc.createCareerDataset(req.body), 201); } catch (e) { fail(res, next, e, 'createCareerDataset'); }
};
exports.updateCareerDataset  = async (req, res, next) => {
  try { ok(res, await svc.updateCareerDataset(req.params.id, req.body)); } catch (e) { fail(res, next, e, 'updateCareerDataset'); }
};
exports.deleteCareerDataset  = async (req, res, next) => {
  try { await svc.deleteCareerDataset(req.params.id); ok(res, { deleted: true }); } catch (e) { fail(res, next, e, 'deleteCareerDataset'); }
};

// ─── 4. CHI Weights ───────────────────────────────────────────────────────────

exports.getCHIWeights    = async (req, res, next) => {
  try { ok(res, await svc.getCHIWeights()); } catch (e) { fail(res, next, e, 'getCHIWeights'); }
};
exports.upsertCHIWeights = async (req, res, next) => {
  try { ok(res, await svc.upsertCHIWeights(req.body)); } catch (e) { fail(res, next, e, 'upsertCHIWeights'); }
};

// ─── 5. Skill Taxonomy ────────────────────────────────────────────────────────

exports.listSkillTaxonomy   = async (req, res, next) => {
  try { ok(res, await svc.listSkillTaxonomy()); } catch (e) { fail(res, next, e, 'listSkillTaxonomy'); }
};
exports.createSkillTaxonomy = async (req, res, next) => {
  try { ok(res, await svc.createSkillTaxonomy(req.body), 201); } catch (e) { fail(res, next, e, 'createSkillTaxonomy'); }
};
exports.updateSkillTaxonomy = async (req, res, next) => {
  try { ok(res, await svc.updateSkillTaxonomy(req.params.id, req.body)); } catch (e) { fail(res, next, e, 'updateSkillTaxonomy'); }
};
exports.deleteSkillTaxonomy = async (req, res, next) => {
  try { await svc.deleteSkillTaxonomy(req.params.id); ok(res, { deleted: true }); } catch (e) { fail(res, next, e, 'deleteSkillTaxonomy'); }
};

// ─── 6. Career Paths ─────────────────────────────────────────────────────────

exports.listCareerPaths   = async (req, res, next) => {
  try { ok(res, await svc.listCareerPaths()); } catch (e) { fail(res, next, e, 'listCareerPaths'); }
};
exports.createCareerPath  = async (req, res, next) => {
  try { ok(res, await svc.createCareerPath(req.body), 201); } catch (e) { fail(res, next, e, 'createCareerPath'); }
};
exports.updateCareerPath  = async (req, res, next) => {
  try { ok(res, await svc.updateCareerPath(req.params.id, req.body)); } catch (e) { fail(res, next, e, 'updateCareerPath'); }
};
exports.deleteCareerPath  = async (req, res, next) => {
  try { await svc.deleteCareerPath(req.params.id); ok(res, { deleted: true }); } catch (e) { fail(res, next, e, 'deleteCareerPath'); }
};

// ─── 7. Training Sources ──────────────────────────────────────────────────────

exports.listTrainingSources   = async (req, res, next) => {
  try { ok(res, await svc.listTrainingSources()); } catch (e) { fail(res, next, e, 'listTrainingSources'); }
};
exports.createTrainingSource  = async (req, res, next) => {
  try { ok(res, await svc.createTrainingSource(req.body), 201); } catch (e) { fail(res, next, e, 'createTrainingSource'); }
};
exports.updateTrainingSource  = async (req, res, next) => {
  try { ok(res, await svc.updateTrainingSource(req.params.id, req.body)); } catch (e) { fail(res, next, e, 'updateTrainingSource'); }
};
exports.deleteTrainingSource  = async (req, res, next) => {
  try { await svc.deleteTrainingSource(req.params.id); ok(res, { deleted: true }); } catch (e) { fail(res, next, e, 'deleteTrainingSource'); }
};

// ─── 8. Subscription Plans ────────────────────────────────────────────────────

exports.listSubscriptionPlans  = async (req, res, next) => {
  try { ok(res, await svc.listSubscriptionPlans()); } catch (e) { fail(res, next, e, 'listSubscriptionPlans'); }
};
exports.upsertSubscriptionPlan = async (req, res, next) => {
  try { ok(res, await svc.upsertSubscriptionPlan(req.params.plan, req.body)); } catch (e) { fail(res, next, e, 'upsertSubscriptionPlan'); }
};

// ─── 9. AI Usage Analytics ───────────────────────────────────────────────────

exports.getAIUsageAnalytics = async (req, res, next) => {
  const days = Math.min(90, parseInt(req.query.days ?? '30', 10));
  try { ok(res, await svc.getAIUsageAnalytics(days)); } catch (e) { fail(res, next, e, 'getAIUsageAnalytics'); }
};
exports.logAIUsage = async (req, res, next) => {
  try { ok(res, await svc.logAIUsage(req.body), 201); } catch (e) { fail(res, next, e, 'logAIUsage'); }
};

// ─── 10. Feature Flags ────────────────────────────────────────────────────────

exports.listFeatureFlags  = async (req, res, next) => {
  try { ok(res, await svc.listFeatureFlags()); } catch (e) { fail(res, next, e, 'listFeatureFlags'); }
};
exports.upsertFeatureFlag = async (req, res, next) => {
  const { enabled } = req.body;
  try { ok(res, await svc.upsertFeatureFlag(req.params.feature, Boolean(enabled))); } catch (e) { fail(res, next, e, 'upsertFeatureFlag'); }
};
exports.bulkSetFeatureFlags = async (req, res, next) => {
  try { ok(res, await svc.bulkSetFeatureFlags(req.body.flags)); } catch (e) { fail(res, next, e, 'bulkSetFeatureFlags'); }
};

// ─── 11. AI Prompts ───────────────────────────────────────────────────────────

exports.listAIPrompts   = async (req, res, next) => {
  try { ok(res, await svc.listAIPrompts()); } catch (e) { fail(res, next, e, 'listAIPrompts'); }
};
exports.getAIPrompt     = async (req, res, next) => {
  try {
    const p = await svc.getAIPrompt(req.params.id);
    if (!p) return res.status(404).json({ success: false, error: 'Prompt not found' });
    ok(res, p);
  } catch (e) { fail(res, next, e, 'getAIPrompt'); }
};
exports.createAIPrompt  = async (req, res, next) => {
  try { ok(res, await svc.createAIPrompt(req.body), 201); } catch (e) { fail(res, next, e, 'createAIPrompt'); }
};
exports.updateAIPrompt  = async (req, res, next) => {
  try { ok(res, await svc.updateAIPrompt(req.params.id, req.body)); } catch (e) { fail(res, next, e, 'updateAIPrompt'); }
};
exports.deleteAIPrompt  = async (req, res, next) => {
  try { await svc.deleteAIPrompt(req.params.id); ok(res, { deleted: true }); } catch (e) { fail(res, next, e, 'deleteAIPrompt'); }
};









