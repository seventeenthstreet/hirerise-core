'use strict';

/**
 * src/modules/platform-intelligence/services/platformIntelligence.service.js
 *
 * Supabase-native service layer for Platform Intelligence.
 * Fully removes remaining Firestore-era assumptions.
 */

const { supabase } = require('../../../config/supabase');
const logger = require('../../../utils/logger');

const {
  TABLES,
  buildAISettingsRow,
  buildMarketSourceRow,
  buildCareerDatasetRow,
  buildCHIWeightsRow,
  buildSkillTaxonomyRow,
  buildCareerPathRow,
  buildTrainingSourceRow,
  buildSubscriptionPlanRow,
  buildAIUsageLogRow,
  buildFeatureFlagRow,
  buildAIPromptRow,
} = require('../models/platformIntelligence.model');

// ─────────────────────────────────────────────────────────────
// Shared DB helpers
// ─────────────────────────────────────────────────────────────

function normalizeDbError(error, context) {
  logger.error(
    {
      context,
      error: error?.message,
      details: error?.details,
      hint: error?.hint,
      code: error?.code,
    },
    '[PlatformIntelligenceService] database operation failed'
  );

  const err = new Error(error?.message || 'Database operation failed');
  err.statusCode = 500;
  throw err;
}

async function getById(table, id) {
  const { data, error } = await supabase
    .from(table)
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) normalizeDbError(error, `getById:${table}`);
  return data;
}

async function listRows(table, orderField = 'created_at') {
  const { data, error } = await supabase
    .from(table)
    .select('*')
    .order(orderField, { ascending: false });

  if (error) normalizeDbError(error, `listRows:${table}`);
  return data || [];
}

async function insertRow(table, row) {
  const { data, error } = await supabase
    .from(table)
    .insert(row)
    .select()
    .single();

  if (error) normalizeDbError(error, `insertRow:${table}`);
  return data;
}

async function updateRow(table, id, row) {
  const { data, error } = await supabase
    .from(table)
    .update(row)
    .eq('id', id)
    .select()
    .single();

  if (error) normalizeDbError(error, `updateRow:${table}`);
  return data;
}

async function upsertById(table, id, row) {
  const payload = { ...row, id };

  const { data, error } = await supabase
    .from(table)
    .upsert(payload, {
      onConflict: 'id',
    })
    .select()
    .single();

  if (error) normalizeDbError(error, `upsertById:${table}`);
  return data;
}

async function deleteRow(table, id) {
  const { error } = await supabase
    .from(table)
    .delete()
    .eq('id', id);

  if (error) normalizeDbError(error, `deleteRow:${table}`);
}

// ─────────────────────────────────────────────────────────────
// 1. AI Settings
// ─────────────────────────────────────────────────────────────

async function getAISettings() {
  const row = await getById(TABLES.AI_SETTINGS, 'config');
  return row ?? buildAISettingsRow({});
}

async function upsertAISettings(fields) {
  return upsertById(
    TABLES.AI_SETTINGS,
    'config',
    buildAISettingsRow(fields)
  );
}

// ─────────────────────────────────────────────────────────────
// 2. Market Sources
// ─────────────────────────────────────────────────────────────

const listMarketSources = () => listRows(TABLES.MARKET_SOURCES);
const getMarketSource = (id) => getById(TABLES.MARKET_SOURCES, id);
const createMarketSource = (fields) =>
  insertRow(TABLES.MARKET_SOURCES, buildMarketSourceRow(fields));
const updateMarketSource = (id, fields) =>
  updateRow(TABLES.MARKET_SOURCES, id, buildMarketSourceRow(fields));
const deleteMarketSource = (id) => deleteRow(TABLES.MARKET_SOURCES, id);

// ─────────────────────────────────────────────────────────────
// 3. Career Datasets
// ─────────────────────────────────────────────────────────────

const listCareerDatasets = () =>
  listRows(TABLES.CAREER_DATASETS, 'uploaded_at');

const getCareerDataset = (id) =>
  getById(TABLES.CAREER_DATASETS, id);

const createCareerDataset = (fields) =>
  insertRow(TABLES.CAREER_DATASETS, buildCareerDatasetRow(fields));

const updateCareerDataset = (id, fields) =>
  updateRow(TABLES.CAREER_DATASETS, id, buildCareerDatasetRow(fields));

const deleteCareerDataset = (id) =>
  deleteRow(TABLES.CAREER_DATASETS, id);

// ─────────────────────────────────────────────────────────────
// 4. CHI Weights
// ─────────────────────────────────────────────────────────────

async function getCHIWeights() {
  const row = await getById(TABLES.CHI_WEIGHTS, 'config');
  return row ?? buildCHIWeightsRow({});
}

async function upsertCHIWeights(fields) {
  const row = buildCHIWeightsRow(fields);

  const total =
    row.skill_weight +
    row.experience_weight +
    row.market_weight +
    row.salary_weight +
    row.education_weight;

  if (Math.round(total) !== 100) {
    const error = new Error('CHI weights must sum to 100');
    error.statusCode = 400;
    throw error;
  }

  return upsertById(TABLES.CHI_WEIGHTS, 'config', row);
}

// ─────────────────────────────────────────────────────────────
// 5. Skill Taxonomy
// ─────────────────────────────────────────────────────────────

const listSkillTaxonomy = () => listRows(TABLES.SKILL_TAXONOMY);
const getSkillTaxonomy = (id) => getById(TABLES.SKILL_TAXONOMY, id);
const createSkillTaxonomy = (fields) =>
  insertRow(TABLES.SKILL_TAXONOMY, buildSkillTaxonomyRow(fields));
const updateSkillTaxonomy = (id, fields) =>
  updateRow(TABLES.SKILL_TAXONOMY, id, buildSkillTaxonomyRow(fields));
const deleteSkillTaxonomy = (id) =>
  deleteRow(TABLES.SKILL_TAXONOMY, id);

// ─────────────────────────────────────────────────────────────
// 6. Career Paths
// ─────────────────────────────────────────────────────────────

const listCareerPaths = () => listRows(TABLES.CAREER_PATHS);
const getCareerPath = (id) => getById(TABLES.CAREER_PATHS, id);
const createCareerPath = (fields) =>
  insertRow(TABLES.CAREER_PATHS, buildCareerPathRow(fields));
const updateCareerPath = (id, fields) =>
  updateRow(TABLES.CAREER_PATHS, id, buildCareerPathRow(fields));
const deleteCareerPath = (id) =>
  deleteRow(TABLES.CAREER_PATHS, id);

// ─────────────────────────────────────────────────────────────
// 7. Training Sources
// ─────────────────────────────────────────────────────────────

const listTrainingSources = () => listRows(TABLES.TRAINING_SOURCES);
const getTrainingSource = (id) =>
  getById(TABLES.TRAINING_SOURCES, id);
const createTrainingSource = (fields) =>
  insertRow(TABLES.TRAINING_SOURCES, buildTrainingSourceRow(fields));
const updateTrainingSource = (id, fields) =>
  updateRow(TABLES.TRAINING_SOURCES, id, buildTrainingSourceRow(fields));
const deleteTrainingSource = (id) =>
  deleteRow(TABLES.TRAINING_SOURCES, id);

// ─────────────────────────────────────────────────────────────
// 8. Subscription Plans
// ─────────────────────────────────────────────────────────────

const listSubscriptionPlans = () =>
  listRows(TABLES.SUBSCRIPTION_PLANS, 'updated_at');

const upsertSubscriptionPlan = (plan, fields) =>
  upsertById(
    TABLES.SUBSCRIPTION_PLANS,
    plan,
    buildSubscriptionPlanRow({
      ...fields,
      plan_name: plan,
    })
  );

// ─────────────────────────────────────────────────────────────
// 9. AI Usage Analytics
// ─────────────────────────────────────────────────────────────

async function getAIUsageAnalytics(days = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data, error } = await supabase
    .from(TABLES.AI_USAGE_LOGS)
    .select('tokens_used,cost,model_used,created_at')
    .gte('created_at', since.toISOString())
    .order('created_at', { ascending: false });

  if (error) normalizeDbError(error, 'getAIUsageAnalytics');

  return {
    total_requests: data.length,
    total_tokens: data.reduce((sum, row) => sum + (row.tokens_used || 0), 0),
    total_cost: data.reduce((sum, row) => sum + Number(row.cost || 0), 0),
    by_model: data.reduce((acc, row) => {
      const key = row.model_used || 'unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
    recent: data.slice(0, 100),
  };
}

async function logAIUsage(fields) {
  return insertRow(TABLES.AI_USAGE_LOGS, buildAIUsageLogRow(fields));
}

// ─────────────────────────────────────────────────────────────
// 10. Feature Flags
// ─────────────────────────────────────────────────────────────

const listFeatureFlags = () => listRows(TABLES.FEATURE_FLAGS, 'updated_at');

const upsertFeatureFlag = (featureName, enabled) =>
  upsertById(
    TABLES.FEATURE_FLAGS,
    featureName,
    buildFeatureFlagRow({
      feature_name: featureName,
      enabled,
    })
  );

async function bulkSetFeatureFlags(flags = []) {
  if (!Array.isArray(flags) || flags.length === 0) return [];

  const rows = flags.map((flag) =>
    buildFeatureFlagRow({
      feature_name: flag.feature_name,
      enabled: flag.enabled,
      id: flag.feature_name,
    })
  );

  const payload = rows.map((row) => ({
    ...row,
    id: row.feature_name,
  }));

  const { data, error } = await supabase
    .from(TABLES.FEATURE_FLAGS)
    .upsert(payload, { onConflict: 'id' })
    .select();

  if (error) normalizeDbError(error, 'bulkSetFeatureFlags');
  return data || [];
}

// ─────────────────────────────────────────────────────────────
// 11. AI Prompts
// ─────────────────────────────────────────────────────────────

const listAIPrompts = () => listRows(TABLES.AI_PROMPTS, 'updated_at');
const getAIPrompt = (id) => getById(TABLES.AI_PROMPTS, id);
const createAIPrompt = (fields) =>
  insertRow(TABLES.AI_PROMPTS, buildAIPromptRow(fields));
const updateAIPrompt = (id, fields) =>
  updateRow(TABLES.AI_PROMPTS, id, buildAIPromptRow(fields));
const deleteAIPrompt = (id) => deleteRow(TABLES.AI_PROMPTS, id);

// ─────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────

module.exports = {
  getAISettings,
  upsertAISettings,

  listMarketSources,
  getMarketSource,
  createMarketSource,
  updateMarketSource,
  deleteMarketSource,

  listCareerDatasets,
  getCareerDataset,
  createCareerDataset,
  updateCareerDataset,
  deleteCareerDataset,

  getCHIWeights,
  upsertCHIWeights,

  listSkillTaxonomy,
  getSkillTaxonomy,
  createSkillTaxonomy,
  updateSkillTaxonomy,
  deleteSkillTaxonomy,

  listCareerPaths,
  getCareerPath,
  createCareerPath,
  updateCareerPath,
  deleteCareerPath,

  listTrainingSources,
  getTrainingSource,
  createTrainingSource,
  updateTrainingSource,
  deleteTrainingSource,

  listSubscriptionPlans,
  upsertSubscriptionPlan,

  getAIUsageAnalytics,
  logAIUsage,

  listFeatureFlags,
  upsertFeatureFlag,
  bulkSetFeatureFlags,

  listAIPrompts,
  getAIPrompt,
  createAIPrompt,
  updateAIPrompt,
  deleteAIPrompt,
};