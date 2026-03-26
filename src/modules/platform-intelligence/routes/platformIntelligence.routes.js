'use strict';

/**
 * routes/platformIntelligence.routes.js
 *
 * Mounted at: /api/v1/admin/platform-intelligence
 * Auth stack: authenticate + requireAdmin (applied in server.js)
 *
 * Sub-routes:
 *   /ai-settings            — AI engine config (singleton)
 *   /market-sources         — LMI data source CRUD
 *   /career-datasets        — Dataset metadata CRUD
 *   /chi-weights            — CHI scoring weights (singleton)
 *   /skill-taxonomy         — Hierarchical skill nodes CRUD
 *   /career-paths           — Career transition rules CRUD
 *   /training-sources       — Course providers CRUD
 *   /subscription-plans     — Plan limits
 *   /ai-usage               — Usage analytics + log ingestion
 *   /feature-flags          — Per-feature on/off toggles
 *   /ai-prompts             — Engine prompt CRUD
 */

const express = require('express');
const router  = express.Router();
const c       = require('../controllers/platformIntelligence.controller');

// 1. AI Settings
router.get ('/ai-settings',         c.getAISettings);
router.post('/ai-settings',         c.upsertAISettings);

// 2. Market Data Sources
router.get   ('/market-sources',        c.listMarketSources);
router.post  ('/market-sources',        c.createMarketSource);
router.put   ('/market-sources/:id',    c.updateMarketSource);
router.delete('/market-sources/:id',    c.deleteMarketSource);

// 3. Career Datasets
router.get   ('/career-datasets',       c.listCareerDatasets);
router.post  ('/career-datasets',       c.createCareerDataset);
router.put   ('/career-datasets/:id',   c.updateCareerDataset);
router.delete('/career-datasets/:id',   c.deleteCareerDataset);

// 4. CHI Weights
router.get ('/chi-weights',        c.getCHIWeights);
router.post('/chi-weights',        c.upsertCHIWeights);

// 5. Skill Taxonomy
router.get   ('/skill-taxonomy',        c.listSkillTaxonomy);
router.post  ('/skill-taxonomy',        c.createSkillTaxonomy);
router.put   ('/skill-taxonomy/:id',    c.updateSkillTaxonomy);
router.delete('/skill-taxonomy/:id',    c.deleteSkillTaxonomy);

// 6. Career Paths
router.get   ('/career-paths',          c.listCareerPaths);
router.post  ('/career-paths',          c.createCareerPath);
router.put   ('/career-paths/:id',      c.updateCareerPath);
router.delete('/career-paths/:id',      c.deleteCareerPath);

// 7. Training Sources
router.get   ('/training-sources',      c.listTrainingSources);
router.post  ('/training-sources',      c.createTrainingSource);
router.put   ('/training-sources/:id',  c.updateTrainingSource);
router.delete('/training-sources/:id',  c.deleteTrainingSource);

// 8. Subscription Plans
router.get('/subscription-plans',            c.listSubscriptionPlans);
router.put('/subscription-plans/:plan',      c.upsertSubscriptionPlan);

// 9. AI Usage Analytics
router.get ('/ai-usage',           c.getAIUsageAnalytics);
router.post('/ai-usage/log',       c.logAIUsage);

// 10. Feature Flags
router.get  ('/feature-flags',             c.listFeatureFlags);
router.put  ('/feature-flags/:feature',    c.upsertFeatureFlag);
router.post ('/feature-flags/bulk',        c.bulkSetFeatureFlags);

// 11. AI Prompts
router.get   ('/ai-prompts',               c.listAIPrompts);
router.get   ('/ai-prompts/:id',           c.getAIPrompt);
router.post  ('/ai-prompts',               c.createAIPrompt);
router.put   ('/ai-prompts/:id',           c.updateAIPrompt);
router.delete('/ai-prompts/:id',           c.deleteAIPrompt);

module.exports = router;









