'use strict';

const supabase = require('../../config/supabase');
const logger = require('../../utils/logger');

class SkillGraphRepository {
  async getSkills() {
    const { data, error } = await supabase
      .from('skills_registry')
      .select(`
        skill_id,
        skill_name,
        skill_category,
        difficulty_level,
        demand_score
      `);

    if (error) {
      logger.error('Failed to fetch skills_registry', {
        error: error.message,
      });
      throw error;
    }

    return data || [];
  }

  async getRelationships() {
    const { data, error } = await supabase
      .from('skill_relationships')
      .select(`
        skill_id,
        related_skill_id,
        relationship_type,
        strength_score
      `);

    if (error) {
      logger.error('Failed to fetch skill_relationships', {
        error: error.message,
      });
      throw error;
    }

    return data || [];
  }

  async getRoleSkills(roleId = null) {
    let query = supabase
      .from('role_skills')
      .select(`
        role_id,
        skill_id,
        skill_type,
        importance_weight
      `);

    if (roleId) {
      query = query
        .eq('role_id', roleId)
        .order('importance_weight', { ascending: false });
    }

    const { data, error } = await query;

    if (error) {
      logger.error('Failed to fetch role_skills', {
        roleId,
        error: error.message,
      });
      throw error;
    }

    return data || [];
  }
}

module.exports = new SkillGraphRepository();
module.exports.SkillGraphRepository = SkillGraphRepository;