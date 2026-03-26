'use strict';

const supabase = require('../../../config/supabase');
const logger   = require('../../../utils/logger');

const TABLE = 'skill_demand_analyses';

class SkillDemandRepository {

  // ─────────────────────────────────────────────
  // SAVE (UPSERT)
  // ─────────────────────────────────────────────

  async saveAnalysis(userId, analysisResult) {

    const id = `${userId}_${_normalizeKey(analysisResult.role)}`;

    const record = {
      id,
      user_id: userId,
      role: analysisResult.role,
      skill_score: analysisResult.skill_score,
      user_skills: analysisResult.user_skills,
      required_skills: analysisResult.required_skills,
      skill_gaps: analysisResult.skill_gaps,
      top_recommended_skills: analysisResult.top_recommended_skills,
      analyzed_at: new Date().toISOString(),
    };

    const { error } = await supabase
      .from(TABLE)
      .upsert(record);

    if (error) {
      logger.error('[SkillDemandRepo] Save failed', { error: error.message });
      throw error;
    }

    logger.info('[SkillDemandRepo] Saved', { userId, role: analysisResult.role });

    return id;
  }

  // ─────────────────────────────────────────────
  // GET SINGLE
  // ─────────────────────────────────────────────

  async getLatestAnalysis(userId, role) {

    const id = `${userId}_${_normalizeKey(role)}`;

    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) {
      logger.error('[SkillDemandRepo] Fetch failed', { error: error.message });
      throw error;
    }

    return data || null;
  }

  // ─────────────────────────────────────────────
  // LIST USER ANALYSES
  // ─────────────────────────────────────────────

  async listUserAnalyses(userId) {

    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('user_id', userId)
      .order('analyzed_at', { ascending: false })
      .limit(20);

    if (error) {
      logger.error('[SkillDemandRepo] List failed', { error: error.message });
      throw error;
    }

    return data || [];
  }
}

// ─────────────────────────────────────────────

function _normalizeKey(str) {
  return (str || '')
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

module.exports = { SkillDemandRepository };





