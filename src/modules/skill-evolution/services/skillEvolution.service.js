'use strict';

/**
 * services/skillEvolution.service.js
 *
 * Service layer for the Skill Evolution Engine.
 *
 * Responsibilities:
 *   - Accept orchestrator outputs (career, stream, cognitive, market)
 *   - Call the SkillRecommendationEngine
 *   - Persist results to Supabase (edu_skill_recommendations + edu_student_skills)
 *   - Provide a read path for the API controller
 */
const logger = require('../../../utils/logger');
const { supabase } = require('../../../config/supabase');
const skillEngine = require('../engines/skillRecommendation.engine');
const {
  COLLECTIONS,
  buildStudentSkillDoc,
  buildSkillRecommendationDoc
} = require('../models/studentSkills.model');
const marketTrendService = require('../../labor-market-intelligence/services/marketTrend.service');

// ─── Run the SEE pipeline and persist results ─────────────────────────────────

/**
 * Generate skill recommendations for a student from engine outputs.
 * Called by the education orchestrator after CareerDigitalTwinEngine.
 *
 * @param {string} studentId
 * @param {object} careerResult     — CareerSuccessEngine output
 * @param {object} streamResult     — StreamIntelligenceEngine output
 * @param {object} cognitiveResult  — CognitiveProfileEngine output
 * @returns {SkillEvolutionResult}
 */
async function generateRecommendations(studentId, {
  careerResult,
  streamResult,
  cognitiveResult
}) {
  logger.info({ studentId }, '[SEE] Generating skill recommendations');

  // ── Load live LMI skill demand (non-blocking fallback) ──────────────────
  let marketDemand = [];
  try {
    marketDemand = await marketTrendService.getSkillDemand(30);
  } catch (err) {
    logger.warn({ err: err.message }, '[SEE] LMI unavailable — using engine static data');
  }

  // ── Run the engine ───────────────────────────────────────────────────────
  const result = skillEngine.recommend({
    careerResult,
    streamResult,
    cognitiveResult,
    marketDemand
  });

  // ── Persist top-level recommendation document ────────────────────────────
  const recommendationDoc = buildSkillRecommendationDoc(studentId, {
    top_career: result.top_career,
    recommended_stream: result.recommended_stream,
    skills: result.skills,
    roadmap: result.roadmap,
    engine_version: result.engine_version
  });

  const { error: upsertRecError } = await supabase
    .from(COLLECTIONS.SKILL_RECOMMENDATIONS)
    .upsert([{
      id: studentId,
      ...recommendationDoc,
      calculated_at: new Date().toISOString()
    }]);

  if (upsertRecError) {
    logger.error({ studentId, error: upsertRecError.message }, '[SEE] Failed to upsert skill recommendations');
    throw new Error(upsertRecError.message);
  }

  // ── Persist per-skill rows (replace previous run) ───────────────────────
  // Delete existing skill rows for this student, then insert fresh ones
  const { error: deleteError } = await supabase
    .from(COLLECTIONS.STUDENT_SKILLS)
    .delete()
    .eq('student_id', studentId);

  if (deleteError) {
    logger.warn({ studentId, error: deleteError.message }, '[SEE] Failed to delete existing student skills');
  }

  if (result.skills && result.skills.length > 0) {
    const skillRows = result.skills.map(skill => ({
      ...buildStudentSkillDoc(studentId, {
        skill_name: skill.skill,
        proficiency_level: 'beginner',
        impact_score: skill.impact,
        career_relevance: skill.career_relevance,
        demand_score: skill.demand_score
      }),
      created_at: new Date().toISOString()
    }));

    const { error: insertSkillsError } = await supabase
      .from(COLLECTIONS.STUDENT_SKILLS)
      .insert(skillRows);

    if (insertSkillsError) {
      logger.error({ studentId, error: insertSkillsError.message }, '[SEE] Failed to insert student skills');
      throw new Error(insertSkillsError.message);
    }
  }

  logger.info({ studentId, skillCount: result.skills.length }, '[SEE] Skill recommendations persisted');
  return result;
}

// ─── Read path ────────────────────────────────────────────────────────────────

/**
 * Retrieve cached skill recommendations for a student.
 * Returns null if not yet generated.
 *
 * @param {string} studentId
 * @returns {object|null}
 */
async function getRecommendations(studentId) {
  const { data, error } = await supabase
    .from(COLLECTIONS.SKILL_RECOMMENDATIONS)
    .select('*')
    .eq('id', studentId)
    .maybeSingle();

  if (error) {
    logger.error({ studentId, error: error.message }, '[SEE] Failed to fetch recommendations');
    throw new Error(error.message);
  }

  if (!data) return null;
  return data;
}

/**
 * Retrieve raw per-skill rows for a student (useful for detailed views).
 *
 * @param {string} studentId
 * @returns {Array}
 */
async function getStudentSkills(studentId) {
  const { data, error } = await supabase
    .from(COLLECTIONS.STUDENT_SKILLS)
    .select('*')
    .eq('student_id', studentId)
    .order('impact_score', { ascending: false });

  if (error) {
    logger.error({ studentId, error: error.message }, '[SEE] Failed to fetch student skills');
    throw new Error(error.message);
  }

  return data || [];
}

module.exports = {
  generateRecommendations,
  getRecommendations,
  getStudentSkills
};
