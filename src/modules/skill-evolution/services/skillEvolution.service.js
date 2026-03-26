'use strict';

/**
 * services/skillEvolution.service.js
 *
 * Service layer for the Skill Evolution Engine.
 *
 * Responsibilities:
 *   - Accept orchestrator outputs (career, stream, cognitive, market)
 *   - Call the SkillRecommendationEngine
 *   - Persist results to Firestore (edu_skill_recommendations + edu_student_skills)
 *   - Provide a read path for the API controller
 */

const logger          = require('../../../utils/logger');
const { db }          = require('../../../config/supabase');
const { FieldValue } = require('../../../config/supabase');
const skillEngine     = require('../engines/skillRecommendation.engine');
const { COLLECTIONS, buildStudentSkillDoc, buildSkillRecommendationDoc } =
  require('../models/studentSkills.model');
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
async function generateRecommendations(studentId, { careerResult, streamResult, cognitiveResult }) {
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
    marketDemand,
  });

  // ── Persist top-level recommendation document ────────────────────────────
  const recommendationDoc = buildSkillRecommendationDoc(studentId, {
    top_career:         result.top_career,
    recommended_stream: result.recommended_stream,
    skills:             result.skills,
    roadmap:            result.roadmap,
    engine_version:     result.engine_version,
  });

  await db.collection(COLLECTIONS.SKILL_RECOMMENDATIONS).doc(studentId).set({
    ...recommendationDoc,
    calculated_at: FieldValue.serverTimestamp(),
  }, { merge: true });

  // ── Persist per-skill rows (replace previous run) ───────────────────────
  const existingSnap = await db
    .collection(COLLECTIONS.STUDENT_SKILLS)
    .where('student_id', '==', studentId)
    .get();

  const batch = db.batch();
  existingSnap.docs.forEach(doc => batch.delete(doc.ref));

  for (const skill of result.skills) {
    const ref = db.collection(COLLECTIONS.STUDENT_SKILLS).doc();
    batch.set(ref, {
      ...buildStudentSkillDoc(studentId, {
        skill_name:        skill.skill,
        proficiency_level: 'beginner',
        impact_score:      skill.impact,
        career_relevance:  skill.career_relevance,
        demand_score:      skill.demand_score,
      }),
      created_at: FieldValue.serverTimestamp(),
    });
  }

  await batch.commit();

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
  const doc = await db.collection(COLLECTIONS.SKILL_RECOMMENDATIONS).doc(studentId).get();
  if (!doc.exists) return null;
  return doc.data();
}

/**
 * Retrieve raw per-skill rows for a student (useful for detailed views).
 *
 * @param {string} studentId
 * @returns {Array}
 */
async function getStudentSkills(studentId) {
  const snap = await db
    .collection(COLLECTIONS.STUDENT_SKILLS)
    .where('student_id', '==', studentId)
    .orderBy('impact_score', 'desc')
    .get();

  return snap.docs.map(d => d.data());
}

module.exports = {
  generateRecommendations,
  getRecommendations,
  getStudentSkills,
};










