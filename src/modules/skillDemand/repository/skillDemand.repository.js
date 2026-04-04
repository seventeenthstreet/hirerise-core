'use strict';

const { supabase } = require('../../../config/supabase');
const logger = require('../../../utils/logger');

const TABLE = 'skill_demand_analyses';
const USER_ANALYSIS_LIMIT = 20;

class SkillDemandRepository {
  /**
   * Save or update a skill demand analysis for a user-role pair.
   * Preserves existing API behavior by using deterministic ID upsert.
   *
   * @param {string} userId
   * @param {Object} analysisResult
   * @returns {Promise<string>}
   */
  async saveAnalysis(userId, analysisResult) {
    const normalizedRole = normalizeKey(analysisResult?.role);
    const id = `${userId}_${normalizedRole}`;

    const record = {
      id,
      user_id: userId,
      role: analysisResult?.role ?? null,
      skill_score: analysisResult?.skill_score ?? null,
      user_skills: analysisResult?.user_skills ?? [],
      required_skills: analysisResult?.required_skills ?? [],
      skill_gaps: analysisResult?.skill_gaps ?? [],
      top_recommended_skills: analysisResult?.top_recommended_skills ?? [],
      analyzed_at: new Date().toISOString(),
    };

    const { error } = await supabase
      .from(TABLE)
      .upsert(record, {
        onConflict: 'id',
        ignoreDuplicates: false,
      });

    if (error) {
      logger.error('[SkillDemandRepository] saveAnalysis failed', {
        userId,
        role: analysisResult?.role,
        error: error.message,
        code: error.code,
      });
      throw error;
    }

    logger.info('[SkillDemandRepository] analysis saved', {
      userId,
      role: analysisResult?.role,
    });

    return id;
  }

  /**
   * Get latest saved analysis for a user-role pair.
   *
   * @param {string} userId
   * @param {string} role
   * @returns {Promise<Object|null>}
   */
  async getLatestAnalysis(userId, role) {
    const id = `${userId}_${normalizeKey(role)}`;

    const { data, error } = await supabase
      .from(TABLE)
      .select(
        `
        id,
        user_id,
        role,
        skill_score,
        user_skills,
        required_skills,
        skill_gaps,
        top_recommended_skills,
        analyzed_at
        `
      )
      .eq('id', id)
      .maybeSingle();

    if (error) {
      logger.error('[SkillDemandRepository] getLatestAnalysis failed', {
        userId,
        role,
        error: error.message,
        code: error.code,
      });
      throw error;
    }

    return data ?? null;
  }

  /**
   * List latest analyses for a user.
   *
   * @param {string} userId
   * @returns {Promise<Array>}
   */
  async listUserAnalyses(userId) {
    const { data, error } = await supabase
      .from(TABLE)
      .select(
        `
        id,
        role,
        skill_score,
        skill_gaps,
        top_recommended_skills,
        analyzed_at
        `
      )
      .eq('user_id', userId)
      .order('analyzed_at', { ascending: false })
      .limit(USER_ANALYSIS_LIMIT);

    if (error) {
      logger.error('[SkillDemandRepository] listUserAnalyses failed', {
        userId,
        error: error.message,
        code: error.code,
      });
      throw error;
    }

    return data ?? [];
  }
}

/**
 * Normalize role names into stable deterministic key fragments.
 *
 * @param {string} value
 * @returns {string}
 */
function normalizeKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

module.exports = { SkillDemandRepository };