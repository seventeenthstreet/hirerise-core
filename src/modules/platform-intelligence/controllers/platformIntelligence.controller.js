'use strict';

/**
 * src/modules/platform-intelligence/controllers/platformIntelligence.controller.js
 *
 * HTTP controller for all Platform Intelligence sub-modules.
 * Fully optimized for Supabase-backed service layer usage.
 *
 * Routes should already enforce:
 *   authenticate + requireAdmin
 */

const service = require('../services/platformIntelligence.service');
const logger = require('../../../utils/logger');

/**
 * Standard success response helper
 */
const sendSuccess = (res, data, statusCode = 200) =>
  res.status(statusCode).json({
    success: true,
    data,
  });

/**
 * Standard error response helper
 */
const handleError = (res, next, error, action, meta = {}) => {
  logger.error(
    {
      action,
      error: error?.message,
      stack: error?.stack,
      ...meta,
    },
    `[PlatformIntelligence] ${action} failed`
  );

  if (error?.statusCode) {
    return res.status(error.statusCode).json({
      success: false,
      error: error.message,
    });
  }

  return next(error);
};

/**
 * Higher-order async controller wrapper
 */
const controller =
  (action, serviceFn, options = {}) =>
  async (req, res, next) => {
    try {
      const result = await serviceFn(req, res);
      return sendSuccess(res, result, options.statusCode || 200);
    } catch (error) {
      return handleError(res, next, error, action, {
        params: req.params,
        query: req.query,
      });
    }
  };

/**
 * Safe positive integer parser with max cap
 */
const parsePositiveInt = (value, fallback, max) => {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
};

// ─────────────────────────────────────────────────────────────
// 1. AI Settings
// ─────────────────────────────────────────────────────────────

exports.getAISettings = controller('getAISettings', () =>
  service.getAISettings()
);

exports.upsertAISettings = controller('upsertAISettings', (req) =>
  service.upsertAISettings(req.body)
);

// ─────────────────────────────────────────────────────────────
// 2. Market Data Sources
// ─────────────────────────────────────────────────────────────

exports.listMarketSources = controller('listMarketSources', () =>
  service.listMarketSources()
);

exports.createMarketSource = controller(
  'createMarketSource',
  (req) => service.createMarketSource(req.body),
  { statusCode: 201 }
);

exports.updateMarketSource = controller('updateMarketSource', (req) =>
  service.updateMarketSource(req.params.id, req.body)
);

exports.deleteMarketSource = controller('deleteMarketSource', async (req) => {
  await service.deleteMarketSource(req.params.id);
  return { deleted: true };
});

// ─────────────────────────────────────────────────────────────
// 3. Career Datasets
// ─────────────────────────────────────────────────────────────

exports.listCareerDatasets = controller('listCareerDatasets', () =>
  service.listCareerDatasets()
);

exports.createCareerDataset = controller(
  'createCareerDataset',
  (req) => service.createCareerDataset(req.body),
  { statusCode: 201 }
);

exports.updateCareerDataset = controller('updateCareerDataset', (req) =>
  service.updateCareerDataset(req.params.id, req.body)
);

exports.deleteCareerDataset = controller('deleteCareerDataset', async (req) => {
  await service.deleteCareerDataset(req.params.id);
  return { deleted: true };
});

// ─────────────────────────────────────────────────────────────
// 4. CHI Weights
// ─────────────────────────────────────────────────────────────

exports.getCHIWeights = controller('getCHIWeights', () =>
  service.getCHIWeights()
);

exports.upsertCHIWeights = controller('upsertCHIWeights', (req) =>
  service.upsertCHIWeights(req.body)
);

// ─────────────────────────────────────────────────────────────
// 5. Skill Taxonomy
// ─────────────────────────────────────────────────────────────

exports.listSkillTaxonomy = controller('listSkillTaxonomy', () =>
  service.listSkillTaxonomy()
);

exports.createSkillTaxonomy = controller(
  'createSkillTaxonomy',
  (req) => service.createSkillTaxonomy(req.body),
  { statusCode: 201 }
);

exports.updateSkillTaxonomy = controller('updateSkillTaxonomy', (req) =>
  service.updateSkillTaxonomy(req.params.id, req.body)
);

exports.deleteSkillTaxonomy = controller('deleteSkillTaxonomy', async (req) => {
  await service.deleteSkillTaxonomy(req.params.id);
  return { deleted: true };
});

// ─────────────────────────────────────────────────────────────
// 6. Career Paths
// ─────────────────────────────────────────────────────────────

exports.listCareerPaths = controller('listCareerPaths', () =>
  service.listCareerPaths()
);

exports.createCareerPath = controller(
  'createCareerPath',
  (req) => service.createCareerPath(req.body),
  { statusCode: 201 }
);

exports.updateCareerPath = controller('updateCareerPath', (req) =>
  service.updateCareerPath(req.params.id, req.body)
);

exports.deleteCareerPath = controller('deleteCareerPath', async (req) => {
  await service.deleteCareerPath(req.params.id);
  return { deleted: true };
});

// ─────────────────────────────────────────────────────────────
// 7. Training Sources
// ─────────────────────────────────────────────────────────────

exports.listTrainingSources = controller('listTrainingSources', () =>
  service.listTrainingSources()
);

exports.createTrainingSource = controller(
  'createTrainingSource',
  (req) => service.createTrainingSource(req.body),
  { statusCode: 201 }
);

exports.updateTrainingSource = controller('updateTrainingSource', (req) =>
  service.updateTrainingSource(req.params.id, req.body)
);

exports.deleteTrainingSource = controller('deleteTrainingSource', async (req) => {
  await service.deleteTrainingSource(req.params.id);
  return { deleted: true };
});

// ─────────────────────────────────────────────────────────────
// 8. Subscription Plans
// ─────────────────────────────────────────────────────────────

exports.listSubscriptionPlans = controller('listSubscriptionPlans', () =>
  service.listSubscriptionPlans()
);

exports.upsertSubscriptionPlan = controller(
  'upsertSubscriptionPlan',
  (req) => service.upsertSubscriptionPlan(req.params.plan, req.body)
);

// ─────────────────────────────────────────────────────────────
// 9. AI Usage Analytics
// ─────────────────────────────────────────────────────────────

exports.getAIUsageAnalytics = controller('getAIUsageAnalytics', (req) => {
  const days = parsePositiveInt(req.query.days, 30, 90);
  return service.getAIUsageAnalytics(days);
});

exports.logAIUsage = controller(
  'logAIUsage',
  (req) => service.logAIUsage(req.body),
  { statusCode: 201 }
);

// ─────────────────────────────────────────────────────────────
// 10. Feature Flags
// ─────────────────────────────────────────────────────────────

exports.listFeatureFlags = controller('listFeatureFlags', () =>
  service.listFeatureFlags()
);

exports.upsertFeatureFlag = controller('upsertFeatureFlag', (req) =>
  service.upsertFeatureFlag(
    req.params.feature,
    Boolean(req.body?.enabled)
  )
);

exports.bulkSetFeatureFlags = controller('bulkSetFeatureFlags', (req) =>
  service.bulkSetFeatureFlags(req.body?.flags || [])
);

// ─────────────────────────────────────────────────────────────
// 11. AI Prompts
// ─────────────────────────────────────────────────────────────

exports.listAIPrompts = controller('listAIPrompts', () =>
  service.listAIPrompts()
);

exports.getAIPrompt = async (req, res, next) => {
  try {
    const prompt = await service.getAIPrompt(req.params.id);

    if (!prompt) {
      return res.status(404).json({
        success: false,
        error: 'Prompt not found',
      });
    }

    return sendSuccess(res, prompt);
  } catch (error) {
    return handleError(res, next, error, 'getAIPrompt', {
      promptId: req.params.id,
    });
  }
};

exports.createAIPrompt = controller(
  'createAIPrompt',
  (req) => service.createAIPrompt(req.body),
  { statusCode: 201 }
);

exports.updateAIPrompt = controller('updateAIPrompt', (req) =>
  service.updateAIPrompt(req.params.id, req.body)
);

exports.deleteAIPrompt = controller('deleteAIPrompt', async (req) => {
  await service.deleteAIPrompt(req.params.id);
  return { deleted: true };
});