'use strict';

/**
 * models/platformIntelligence.model.js
 *
 * Firestore collection names and document builders for all 11
 * Platform Intelligence & Control Center sub-modules.
 *
 * Collections (prefixed pi_ to stay isolated from existing modules):
 *
 *   pi_ai_model_settings      — AI engine model + parameter config
 *   pi_market_data_sources     — external LMI API registrations
 *   pi_career_datasets         — uploaded dataset metadata
 *   pi_chi_weights             — CHI scoring weight config
 *   pi_skill_taxonomy          — hierarchical skill tree nodes
 *   pi_career_paths            — career transition rules
 *   pi_training_sources        — course provider + course mappings
 *   pi_subscription_plans      — plan limits (Free / Pro / Enterprise)
 *   pi_ai_usage_logs           — per-request AI usage records
 *   pi_feature_flags           — per-feature on/off toggles
 *   pi_ai_prompts              — editable engine prompts
 */

const COLLECTIONS = {
  AI_SETTINGS:        'pi_ai_model_settings',
  MARKET_SOURCES:     'pi_market_data_sources',
  CAREER_DATASETS:    'pi_career_datasets',
  CHI_WEIGHTS:        'pi_chi_weights',
  SKILL_TAXONOMY:     'pi_skill_taxonomy',
  CAREER_PATHS:       'pi_career_paths',
  TRAINING_SOURCES:   'pi_training_sources',
  SUBSCRIPTION_PLANS: 'pi_subscription_plans',
  AI_USAGE_LOGS:      'pi_ai_usage_logs',
  FEATURE_FLAGS:      'pi_feature_flags',
  AI_PROMPTS:         'pi_ai_prompts',
};

// ─── Document builders ────────────────────────────────────────────────────────

/** pi_ai_model_settings — singleton doc id: 'config' */
function buildAISettingsDoc(f) {
  return {
    primary_model:   f.primary_model   || 'claude-sonnet-4-5',
    fallback_model:  f.fallback_model  || 'gpt-4o-mini',
    temperature:     f.temperature     != null ? Number(f.temperature)  : 0.3,
    max_tokens:      f.max_tokens      != null ? Number(f.max_tokens)   : 1200,
    analysis_mode:   f.analysis_mode   || 'balanced',
    updated_at:      null, // serverTimestamp
  };
}

/** pi_market_data_sources/{id} */
function buildMarketSourceDoc(f) {
  return {
    name:             f.name             || null,
    api_key:          f.api_key          || null,
    endpoint:         f.endpoint         || null,
    region:           f.region           || 'global',
    update_frequency: f.update_frequency || 'daily',
    status:           f.status           || 'active',
    created_at:       null,
  };
}

/** pi_career_datasets/{id} */
function buildCareerDatasetDoc(f) {
  return {
    dataset_name: f.dataset_name || null,
    dataset_type: f.dataset_type || null, // 'job_roles'|'salary_benchmarks'|'skill_taxonomy'|'industry_demand'
    file_url:     f.file_url     || null,
    version:      f.version      || '1.0.0',
    uploaded_at:  null,
  };
}

/** pi_chi_weights — singleton doc id: 'config' */
function buildCHIWeightsDoc(f) {
  return {
    skill_weight:      f.skill_weight      != null ? Number(f.skill_weight)      : 25,
    experience_weight: f.experience_weight != null ? Number(f.experience_weight) : 20,
    market_weight:     f.market_weight     != null ? Number(f.market_weight)     : 20,
    salary_weight:     f.salary_weight     != null ? Number(f.salary_weight)     : 20,
    education_weight:  f.education_weight  != null ? Number(f.education_weight)  : 15,
    updated_at:        null,
  };
}

/** pi_skill_taxonomy/{id} */
function buildSkillTaxonomyDoc(f) {
  return {
    skill_name:     f.skill_name     || null,
    parent_skill_id:f.parent_skill_id|| null,
    category:       f.category       || null,
    created_at:     null,
  };
}

/** pi_career_paths/{id} */
function buildCareerPathDoc(f) {
  return {
    from_role:        f.from_role        || null,
    to_role:          f.to_role          || null,
    required_skills:  Array.isArray(f.required_skills) ? f.required_skills : [],
    min_experience:   f.min_experience   != null ? Number(f.min_experience) : 0,
    salary_range:     f.salary_range     || null,
    probability_score:f.probability_score!= null ? Number(f.probability_score): 0,
    created_at:       null,
  };
}

/** pi_training_sources/{id} */
function buildTrainingSourceDoc(f) {
  return {
    provider_name: f.provider_name || null,
    course_name:   f.course_name   || null,
    mapped_skill:  f.mapped_skill  || null,
    difficulty:    f.difficulty    || 'beginner',
    duration:      f.duration      || null,
    cost:          f.cost          != null ? Number(f.cost) : 0,
    link:          f.link          || null,
    created_at:    null,
  };
}

/** pi_subscription_plans/{plan_name} — doc id = plan name */
function buildSubscriptionPlanDoc(f) {
  return {
    plan_name:             f.plan_name             || null,
    monthly_price:         f.monthly_price         != null ? Number(f.monthly_price)          : 0,
    career_analyses_limit: f.career_analyses_limit != null ? Number(f.career_analyses_limit)  : 0,
    resume_scans_limit:    f.resume_scans_limit    != null ? Number(f.resume_scans_limit)     : 0,
    market_reports_limit:  f.market_reports_limit  != null ? Number(f.market_reports_limit)   : 0,
    api_calls_limit:       f.api_calls_limit       != null ? Number(f.api_calls_limit)        : 0,
    updated_at:            null,
  };
}

/** pi_ai_usage_logs/{autoId} */
function buildAIUsageLogDoc(f) {
  return {
    user_id:    f.user_id    || null,
    action:     f.action     || null,
    tokens_used:f.tokens_used!= null ? Number(f.tokens_used) : 0,
    model_used: f.model_used || null,
    cost:       f.cost       != null ? Number(f.cost) : 0,
    created_at: null,
  };
}

/** pi_feature_flags/{feature_name} — doc id = feature_name */
function buildFeatureFlagDoc(f) {
  return {
    feature_name: f.feature_name || null,
    enabled:      typeof f.enabled === 'boolean' ? f.enabled : false,
    updated_at:   null,
  };
}

/** pi_ai_prompts/{id} */
function buildAIPromptDoc(f) {
  return {
    prompt_name: f.prompt_name || null,
    prompt_text: f.prompt_text || null,
    engine:      f.engine      || null,
    version:     f.version     || '1.0.0',
    updated_at:  null,
  };
}

module.exports = {
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
};









