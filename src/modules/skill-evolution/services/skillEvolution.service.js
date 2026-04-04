'use strict';

/**
 * src/modules/skill-evolution/services/skillEvolution.service.js
 *
 * Skill Evolution Engine service layer
 *
 * Fully Supabase-native:
 * - atomic upsert-safe persistence
 * - DB-owned timestamps
 * - no Firestore delete+rewrite patterns
 * - conflict-safe row writes
 * - optimized read paths
 */

const logger = require('../../../utils/logger');
const { supabase } = require('../../../config/supabase');

const skillEngine = require('../engines/skillRecommendation.engine');
const {
  TABLES,
  buildStudentSkillRow,
  buildSkillRecommendationRow,
} = require('../models/studentSkills.model');

const marketTrendService = require('../../labor-market-intelligence/services/marketTrend.service');

// ─────────────────────────────────────────────────────────────────────────────
// Generate + persist recommendations
// ─────────────────────────────────────────────────────────────────────────────

async function generateRecommendations(
  studentId,
  {
    careerResult = {},
    streamResult = {},
    cognitiveResult = {},
  } = {}
) {
  logger.info(
    { studentId },
    '[SEE] Generating skill recommendations'
  );

  let marketDemand = [];

  try {
    marketDemand = await marketTrendService.getSkillDemand(30);
  } catch (err) {
    logger.warn(
      { studentId, error: err.message },
      '[SEE] LMI unavailable — using static fallback'
    );
  }

  const result = skillEngine.recommend({
    careerResult,
    streamResult,
    cognitiveResult,
    marketDemand,
  });

  // ── Upsert cached recommendation row ─────────────────────────────────────
  const recommendationRow = buildSkillRecommendationRow(
    studentId,
    result
  );

  const { error: recommendationError } = await supabase
    .from(TABLES.SKILL_RECOMMENDATIONS)
    .upsert(recommendationRow, {
      onConflict: 'student_id',
    });

  if (recommendationError) {
    logger.error(
      {
        studentId,
        error: recommendationError.message,
      },
      '[SEE] Failed to upsert recommendation cache'
    );

    throw recommendationError;
  }

  // ── Bulk upsert skill rows ───────────────────────────────────────────────
  const skillRows = Array.isArray(result.skills)
    ? result.skills.map((skill) =>
        buildStudentSkillRow(studentId, {
          skill_name: skill.skill,
          proficiency_level: 'beginner',
          impact_score: skill.impact,
          career_relevance: skill.career_relevance,
          demand_score: skill.demand_score,
        })
      )
    : [];

  if (skillRows.length > 0) {
    const { error: skillsError } = await supabase
      .from(TABLES.STUDENT_SKILLS)
      .upsert(skillRows, {
        onConflict: 'student_id,skill_name',
      });

    if (skillsError) {
      logger.error(
        {
          studentId,
          error: skillsError.message,
        },
        '[SEE] Failed to bulk upsert student skills'
      );

      throw skillsError;
    }
  }

  logger.info(
    {
      studentId,
      skillCount: skillRows.length,
      topCareer: result.top_career,
    },
    '[SEE] Skill recommendations persisted successfully'
  );

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Read cached recommendation
// ─────────────────────────────────────────────────────────────────────────────

async function getRecommendations(studentId) {
  const { data, error } = await supabase
    .from(TABLES.SKILL_RECOMMENDATIONS)
    .select(
      `
      student_id,
      top_career,
      recommended_stream,
      skills,
      roadmap,
      engine_version,
      calculated_at,
      updated_at
      `
    )
    .eq('student_id', studentId)
    .maybeSingle();

  if (error) {
    logger.error(
      { studentId, error: error.message },
      '[SEE] Failed to fetch recommendations'
    );
    throw error;
  }

  return data || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Read student skills
// ─────────────────────────────────────────────────────────────────────────────

async function getStudentSkills(studentId) {
  const { data, error } = await supabase
    .from(TABLES.STUDENT_SKILLS)
    .select(
      `
      student_id,
      skill_name,
      proficiency_level,
      impact_score,
      career_relevance,
      demand_score,
      created_at,
      updated_at
      `
    )
    .eq('student_id', studentId)
    .order('impact_score', { ascending: false });

  if (error) {
    logger.error(
      { studentId, error: error.message },
      '[SEE] Failed to fetch student skills'
    );
    throw error;
  }

  return data || [];
}

module.exports = {
  generateRecommendations,
  getRecommendations,
  getStudentSkills,
};