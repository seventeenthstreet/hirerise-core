'use strict';

/**
 * src/modules/platform-intelligence/models/platformIntelligence.model.js
 *
 * Supabase-first table names and row builders for all Platform Intelligence
 * sub-modules.
 *
 * IMPORTANT:
 * - Replaces Firestore "collection/document" terminology
 * - Optimized for PostgreSQL row inserts + upserts
 * - Timestamp columns should be DB-managed via DEFAULT now() + update triggers
 * - Builders intentionally exclude created_at / updated_at unless explicitly set
 */

const TABLES = Object.freeze({
  AI_SETTINGS: 'pi_ai_model_settings',
  MARKET_SOURCES: 'pi_market_data_sources',
  CAREER_DATASETS: 'pi_career_datasets',
  CHI_WEIGHTS: 'pi_chi_weights',
  SKILL_TAXONOMY: 'pi_skill_taxonomy',
  CAREER_PATHS: 'pi_career_paths',
  TRAINING_SOURCES: 'pi_training_sources',
  SUBSCRIPTION_PLANS: 'pi_subscription_plans',
  AI_USAGE_LOGS: 'pi_ai_usage_logs',
  FEATURE_FLAGS: 'pi_feature_flags',
  AI_PROMPTS: 'pi_ai_prompts',
});

/**
 * Safe number coercion helper
 */
function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Safe string helper
 */
function toNullableString(value, fallback = null) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return String(value).trim();
}

/**
 * Safe array helper
 */
function toArray(value) {
  return Array.isArray(value) ? value : [];
}

// ─────────────────────────────────────────────────────────────
// Row builders
// ─────────────────────────────────────────────────────────────

function buildAISettingsRow(input = {}) {
  return {
    primary_model: toNullableString(input.primary_model, 'claude-sonnet-4-5'),
    fallback_model: toNullableString(input.fallback_model, 'gpt-4o-mini'),
    temperature: toNumber(input.temperature, 0.3),
    max_tokens: toNumber(input.max_tokens, 1200),
    analysis_mode: toNullableString(input.analysis_mode, 'balanced'),
  };
}

function buildMarketSourceRow(input = {}) {
  return {
    name: toNullableString(input.name),
    api_key: toNullableString(input.api_key),
    endpoint: toNullableString(input.endpoint),
    region: toNullableString(input.region, 'global'),
    update_frequency: toNullableString(input.update_frequency, 'daily'),
    status: toNullableString(input.status, 'active'),
  };
}

function buildCareerDatasetRow(input = {}) {
  return {
    dataset_name: toNullableString(input.dataset_name),
    dataset_type: toNullableString(input.dataset_type),
    file_url: toNullableString(input.file_url),
    version: toNullableString(input.version, '1.0.0'),
  };
}

function buildCHIWeightsRow(input = {}) {
  return {
    skill_weight: toNumber(input.skill_weight, 25),
    experience_weight: toNumber(input.experience_weight, 20),
    market_weight: toNumber(input.market_weight, 20),
    salary_weight: toNumber(input.salary_weight, 20),
    education_weight: toNumber(input.education_weight, 15),
  };
}

function buildSkillTaxonomyRow(input = {}) {
  return {
    skill_name: toNullableString(input.skill_name),
    parent_skill_id: toNullableString(input.parent_skill_id),
    category: toNullableString(input.category),
  };
}

function buildCareerPathRow(input = {}) {
  return {
    from_role: toNullableString(input.from_role),
    to_role: toNullableString(input.to_role),
    required_skills: toArray(input.required_skills),
    min_experience: toNumber(input.min_experience, 0),
    salary_range: input.salary_range ?? null,
    probability_score: toNumber(input.probability_score, 0),
  };
}

function buildTrainingSourceRow(input = {}) {
  return {
    provider_name: toNullableString(input.provider_name),
    course_name: toNullableString(input.course_name),
    mapped_skill: toNullableString(input.mapped_skill),
    difficulty: toNullableString(input.difficulty, 'beginner'),
    duration: toNullableString(input.duration),
    cost: toNumber(input.cost, 0),
    link: toNullableString(input.link),
  };
}

function buildSubscriptionPlanRow(input = {}) {
  return {
    plan_name: toNullableString(input.plan_name),
    monthly_price: toNumber(input.monthly_price, 0),
    career_analyses_limit: toNumber(input.career_analyses_limit, 0),
    resume_scans_limit: toNumber(input.resume_scans_limit, 0),
    market_reports_limit: toNumber(input.market_reports_limit, 0),
    api_calls_limit: toNumber(input.api_calls_limit, 0),
  };
}

function buildAIUsageLogRow(input = {}) {
  return {
    user_id: toNullableString(input.user_id),
    action: toNullableString(input.action),
    tokens_used: toNumber(input.tokens_used, 0),
    model_used: toNullableString(input.model_used),
    cost: toNumber(input.cost, 0),
  };
}

function buildFeatureFlagRow(input = {}) {
  return {
    feature_name: toNullableString(input.feature_name),
    enabled: Boolean(input.enabled),
  };
}

function buildAIPromptRow(input = {}) {
  return {
    prompt_name: toNullableString(input.prompt_name),
    prompt_text: toNullableString(input.prompt_text),
    engine: toNullableString(input.engine),
    version: toNullableString(input.version, '1.0.0'),
  };
}

module.exports = {
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
};