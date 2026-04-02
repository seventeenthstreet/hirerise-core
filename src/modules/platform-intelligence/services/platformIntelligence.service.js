'use strict';

const { supabase } = require('../../../config/supabase');
const logger   = require('../../../utils/logger');

const {
  COLLECTIONS,
  buildAISettingsDoc,
  buildMarketSourceDoc,
  buildCareerDatasetDoc,
  buildCHIWeightsDoc,
  buildSkillTaxonomyDoc,
  buildCareerPathDoc,
  buildTrainingSourceDoc,
  buildSubscriptionPlanDoc,
  buildAIUsageLogDoc,
  buildFeatureFlagDoc,
  buildAIPromptDoc,
} = require('../models/platformIntelligence.model');

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function _get(table, id) {
  const { data, error } = await supabase
    .from(table)
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data;
}

async function _list(table, orderField = 'created_at') {
  const { data, error } = await supabase
    .from(table)
    .select('*')
    .order(orderField, { ascending: false });

  if (error) throw new Error(error.message);
  return data || [];
}

async function _create(table, doc) {
  const { data, error } = await supabase
    .from(table)
    .insert({ ...doc, created_at: new Date().toISOString() })
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

async function _update(table, id, partial) {
  const { data, error } = await supabase
    .from(table)
    .update({ ...partial, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

async function _delete(table, id) {
  const { error } = await supabase
    .from(table)
    .delete()
    .eq('id', id);

  if (error) throw new Error(error.message);
}

// ─── AI Settings ──────────────────────────────────────────────────────────────

async function getAISettings() {
  const doc = await _get(COLLECTIONS.AI_SETTINGS, 'config');
  return doc ?? buildAISettingsDoc({});
}

async function upsertAISettings(fields) {
  return _update(COLLECTIONS.AI_SETTINGS, 'config', buildAISettingsDoc(fields));
}

// ─── Market Sources ───────────────────────────────────────────────────────────

const listMarketSources  = () => _list(COLLECTIONS.MARKET_SOURCES);
const getMarketSource    = id  => _get(COLLECTIONS.MARKET_SOURCES, id);
const createMarketSource = f   => _create(COLLECTIONS.MARKET_SOURCES, buildMarketSourceDoc(f));
const updateMarketSource = (id, f) => _update(COLLECTIONS.MARKET_SOURCES, id, f);
const deleteMarketSource = id  => _delete(COLLECTIONS.MARKET_SOURCES, id);

// ─── Career Datasets ─────────────────────────────────────────────────────────

const listCareerDatasets  = () => _list(COLLECTIONS.CAREER_DATASETS, 'uploaded_at');
const getCareerDataset    = id  => _get(COLLECTIONS.CAREER_DATASETS, id);
const createCareerDataset = f   => _create(COLLECTIONS.CAREER_DATASETS, {
  ...buildCareerDatasetDoc(f),
  uploaded_at: new Date().toISOString()
});
const updateCareerDataset = (id, f) => _update(COLLECTIONS.CAREER_DATASETS, id, f);
const deleteCareerDataset = id  => _delete(COLLECTIONS.CAREER_DATASETS, id);

// ─── CHI Weights ─────────────────────────────────────────────────────────────

async function getCHIWeights() {
  const doc = await _get(COLLECTIONS.CHI_WEIGHTS, 'config');
  return doc ?? buildCHIWeightsDoc({});
}

async function upsertCHIWeights(fields) {
  const total = ['skill_weight','experience_weight','market_weight','salary_weight','education_weight']
    .reduce((sum, k) => sum + (Number(fields[k]) || 0), 0);

  if (Math.round(total) !== 100) {
    throw new Error('CHI weights must sum to 100');
  }

  return _update(COLLECTIONS.CHI_WEIGHTS, 'config', buildCHIWeightsDoc(fields));
}

// ─── Skill Taxonomy ──────────────────────────────────────────────────────────

const listSkillTaxonomy  = () => _list(COLLECTIONS.SKILL_TAXONOMY);
const getSkillTaxonomy   = id  => _get(COLLECTIONS.SKILL_TAXONOMY, id);
const createSkillTaxonomy = f  => _create(COLLECTIONS.SKILL_TAXONOMY, buildSkillTaxonomyDoc(f));
const updateSkillTaxonomy = (id, f) => _update(COLLECTIONS.SKILL_TAXONOMY, id, f);
const deleteSkillTaxonomy = id => _delete(COLLECTIONS.SKILL_TAXONOMY, id);

// ─── Career Paths ────────────────────────────────────────────────────────────

const listCareerPaths  = () => _list(COLLECTIONS.CAREER_PATHS);
const getCareerPath    = id  => _get(COLLECTIONS.CAREER_PATHS, id);
const createCareerPath = f   => _create(COLLECTIONS.CAREER_PATHS, buildCareerPathDoc(f));
const updateCareerPath = (id, f) => _update(COLLECTIONS.CAREER_PATHS, id, f);
const deleteCareerPath = id  => _delete(COLLECTIONS.CAREER_PATHS, id);

// ─── Training Sources ────────────────────────────────────────────────────────

const listTrainingSources  = () => _list(COLLECTIONS.TRAINING_SOURCES);
const getTrainingSource    = id  => _get(COLLECTIONS.TRAINING_SOURCES, id);
const createTrainingSource = f   => _create(COLLECTIONS.TRAINING_SOURCES, buildTrainingSourceDoc(f));
const updateTrainingSource = (id, f) => _update(COLLECTIONS.TRAINING_SOURCES, id, f);
const deleteTrainingSource = id  => _delete(COLLECTIONS.TRAINING_SOURCES, id);

// ─── Feature Flags ───────────────────────────────────────────────────────────

const listFeatureFlags  = () => _list(COLLECTIONS.FEATURE_FLAGS);
const upsertFeatureFlag = (name, enabled) =>
  _update(COLLECTIONS.FEATURE_FLAGS, name, buildFeatureFlagDoc({ feature_name: name, enabled }));

// ─── AI Usage ────────────────────────────────────────────────────────────────

async function logAIUsage(fields) {
  return _create(COLLECTIONS.AI_USAGE_LOGS, buildAIUsageLogDoc(fields));
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  getAISettings, upsertAISettings,
  listMarketSources, getMarketSource, createMarketSource, updateMarketSource, deleteMarketSource,
  listCareerDatasets, getCareerDataset, createCareerDataset, updateCareerDataset, deleteCareerDataset,
  getCHIWeights, upsertCHIWeights,
  listSkillTaxonomy, getSkillTaxonomy, createSkillTaxonomy, updateSkillTaxonomy, deleteSkillTaxonomy,
  listCareerPaths, getCareerPath, createCareerPath, updateCareerPath, deleteCareerPath,
  listTrainingSources, getTrainingSource, createTrainingSource, updateTrainingSource, deleteTrainingSource,
  listFeatureFlags, upsertFeatureFlag,
  logAIUsage,
};





