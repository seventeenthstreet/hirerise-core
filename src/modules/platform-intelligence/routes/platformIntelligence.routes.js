'use strict';

/**
 * src/modules/platform-intelligence/routes/platformIntelligence.routes.js
 *
 * Mounted at:
 *   /api/v1/admin/platform-intelligence
 *
 * Auth middleware stack:
 *   authenticate + requireAdmin
 *
 * Notes:
 * - Controller/service/model layers are fully Supabase-native
 * - Route order preserves static paths before dynamic params
 * - Uses grouped route chaining for maintainability
 */

const express = require('express');
const router = express.Router();
const controller = require('../controllers/platformIntelligence.controller');

// ─────────────────────────────────────────────────────────────
// 1. AI Settings (singleton)
// ─────────────────────────────────────────────────────────────

router
  .route('/ai-settings')
  .get(controller.getAISettings)
  .post(controller.upsertAISettings);

// ─────────────────────────────────────────────────────────────
// 2. Market Data Sources
// ─────────────────────────────────────────────────────────────

router
  .route('/market-sources')
  .get(controller.listMarketSources)
  .post(controller.createMarketSource);

router
  .route('/market-sources/:id')
  .put(controller.updateMarketSource)
  .delete(controller.deleteMarketSource);

// ─────────────────────────────────────────────────────────────
// 3. Career Datasets
// ─────────────────────────────────────────────────────────────

router
  .route('/career-datasets')
  .get(controller.listCareerDatasets)
  .post(controller.createCareerDataset);

router
  .route('/career-datasets/:id')
  .put(controller.updateCareerDataset)
  .delete(controller.deleteCareerDataset);

// ─────────────────────────────────────────────────────────────
// 4. CHI Weights (singleton)
// ─────────────────────────────────────────────────────────────

router
  .route('/chi-weights')
  .get(controller.getCHIWeights)
  .post(controller.upsertCHIWeights);

// ─────────────────────────────────────────────────────────────
// 5. Skill Taxonomy
// ─────────────────────────────────────────────────────────────

router
  .route('/skill-taxonomy')
  .get(controller.listSkillTaxonomy)
  .post(controller.createSkillTaxonomy);

router
  .route('/skill-taxonomy/:id')
  .put(controller.updateSkillTaxonomy)
  .delete(controller.deleteSkillTaxonomy);

// ─────────────────────────────────────────────────────────────
// 6. Career Paths
// ─────────────────────────────────────────────────────────────

router
  .route('/career-paths')
  .get(controller.listCareerPaths)
  .post(controller.createCareerPath);

router
  .route('/career-paths/:id')
  .put(controller.updateCareerPath)
  .delete(controller.deleteCareerPath);

// ─────────────────────────────────────────────────────────────
// 7. Training Sources
// ─────────────────────────────────────────────────────────────

router
  .route('/training-sources')
  .get(controller.listTrainingSources)
  .post(controller.createTrainingSource);

router
  .route('/training-sources/:id')
  .put(controller.updateTrainingSource)
  .delete(controller.deleteTrainingSource);

// ─────────────────────────────────────────────────────────────
// 8. Subscription Plans
// ─────────────────────────────────────────────────────────────

router
  .route('/subscription-plans')
  .get(controller.listSubscriptionPlans);

router
  .route('/subscription-plans/:plan')
  .put(controller.upsertSubscriptionPlan);

// ─────────────────────────────────────────────────────────────
// 9. AI Usage Analytics
// ─────────────────────────────────────────────────────────────

router
  .route('/ai-usage')
  .get(controller.getAIUsageAnalytics);

router
  .route('/ai-usage/log')
  .post(controller.logAIUsage);

// ─────────────────────────────────────────────────────────────
// 10. Feature Flags
// ─────────────────────────────────────────────────────────────

router
  .route('/feature-flags')
  .get(controller.listFeatureFlags);

router
  .route('/feature-flags/bulk')
  .post(controller.bulkSetFeatureFlags);

router
  .route('/feature-flags/:feature')
  .put(controller.upsertFeatureFlag);

// ─────────────────────────────────────────────────────────────
// 11. AI Prompts
// ─────────────────────────────────────────────────────────────

router
  .route('/ai-prompts')
  .get(controller.listAIPrompts)
  .post(controller.createAIPrompt);

router
  .route('/ai-prompts/:id')
  .get(controller.getAIPrompt)
  .put(controller.updateAIPrompt)
  .delete(controller.deleteAIPrompt);

module.exports = router;