'use strict';

/**
 * adaptiveWeight.repository.js
 *
 * Pure RPC-based repository
 * - No direct table access
 * - No Firebase patterns
 * - Supabase optimized
 */

const { supabase } = require('../../config/supabase');
const logger = require('../../utils/logger');

class AdaptiveWeightRepository {
  constructor() {
    this._db = supabase;
  }

  // ═══════════════════════════════════════════════════════════
  // 🎯 GET WEIGHTS (RPC)
  // ═══════════════════════════════════════════════════════════

  async getWeights({
    roleFamily,
    experienceBucket,
    industryTag,
    requestId,
  }) {
    try {
      const { data, error } = await this._db.rpc(
        'get_adaptive_weights',
        {
          p_role_family: roleFamily,
          p_experience_bucket: experienceBucket,
          p_industry_tag: industryTag,
        }
      );

      if (error) {
        logger.error('[AdaptiveWeightRepo:getWeights]', {
          requestId,
          error: error.message,
        });
        throw error;
      }

      return data;

    } catch (err) {
      logger.error('[AdaptiveWeightRepo:getWeights:exception]', {
        requestId,
        error: err.message,
      });
      throw err;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 📥 RECORD OUTCOME (RPC)
  // ═══════════════════════════════════════════════════════════

  async recordOutcome({
    roleFamily,
    experienceBucket,
    industryTag,
    predictedScore,
    actualOutcome,
    requestId,
  }) {
    try {
      const { data, error } = await this._db.rpc(
        'record_adaptive_outcome',
        {
          p_role_family: roleFamily,
          p_experience_bucket: experienceBucket,
          p_industry_tag: industryTag,
          p_predicted_score: predictedScore,
          p_actual_outcome: actualOutcome,
        }
      );

      if (error) {
        logger.error('[AdaptiveWeightRepo:recordOutcome]', {
          requestId,
          error: error.message,
        });
        throw error;
      }

      return data;

    } catch (err) {
      logger.error('[AdaptiveWeightRepo:recordOutcome:exception]', {
        requestId,
        error: err.message,
      });
      throw err;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 🛠️ APPLY OVERRIDE (RPC)
  // ═══════════════════════════════════════════════════════════

  async applyOverride({
    roleFamily,
    experienceBucket,
    industryTag,
    weights,
    requestId,
  }) {
    try {
      const { data, error } = await this._db.rpc(
        'apply_adaptive_override',
        {
          p_role_family: roleFamily,
          p_experience_bucket: experienceBucket,
          p_industry_tag: industryTag,
          p_skills: weights.skills,
          p_experience: weights.experience,
          p_education: weights.education,
          p_projects: weights.projects,
        }
      );

      if (error) {
        logger.error('[AdaptiveWeightRepo:applyOverride]', {
          requestId,
          error: error.message,
        });
        throw error;
      }

      return data;

    } catch (err) {
      logger.error('[AdaptiveWeightRepo:applyOverride:exception]', {
        requestId,
        error: err.message,
      });
      throw err;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 🔓 RELEASE OVERRIDE (RPC)
  // ═══════════════════════════════════════════════════════════

  async releaseOverride({
    roleFamily,
    experienceBucket,
    industryTag,
    requestId,
  }) {
    try {
      const { data, error } = await this._db.rpc(
        'release_adaptive_override',
        {
          p_role_family: roleFamily,
          p_experience_bucket: experienceBucket,
          p_industry_tag: industryTag,
        }
      );

      if (error) {
        logger.error('[AdaptiveWeightRepo:releaseOverride]', {
          requestId,
          error: error.message,
        });
        throw error;
      }

      return data;

    } catch (err) {
      logger.error('[AdaptiveWeightRepo:releaseOverride:exception]', {
        requestId,
        error: err.message,
      });
      throw err;
    }
  }
}

module.exports = AdaptiveWeightRepository;
