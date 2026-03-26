'use strict';

/**
 * models/studentSkills.model.js
 *
 * Firestore collection for the Skill Evolution Engine.
 *
 * Collection: edu_student_skills
 *   One document per (student_id, skill_name) pair.
 *   Written by the orchestrator after the SEE pipeline step.
 *   Read by the skill controller when serving /api/skills/recommendations/:studentId
 */

const COLLECTIONS = {
  STUDENT_SKILLS:      'edu_student_skills',
  SKILL_RECOMMENDATIONS: 'edu_skill_recommendations', // cached ranked list per student
};

const PROFICIENCY_LEVELS = ['beginner', 'intermediate', 'advanced', 'expert'];

/**
 * edu_student_skills/{autoId}
 *
 *   id               — auto-generated Firestore ID
 *   student_id       — user ID
 *   skill_name       — string
 *   proficiency_level — PROFICIENCY_LEVELS value
 *   impact_score     — number 0–100 (calculated by SEE)
 *   career_relevance — number 0–1 (how relevant to top career)
 *   demand_score     — number 0–100 (from LMI)
 *   created_at       — serverTimestamp
 */
function buildStudentSkillDoc(studentId, fields) {
  return {
    student_id:        studentId,
    skill_name:        fields.skill_name        || null,
    proficiency_level: fields.proficiency_level || 'beginner',
    impact_score:      fields.impact_score      != null ? Number(fields.impact_score)      : null,
    career_relevance:  fields.career_relevance  != null ? Number(fields.career_relevance)  : null,
    demand_score:      fields.demand_score      != null ? Number(fields.demand_score)       : null,
    created_at:        null, // set by repository
  };
}

/**
 * edu_skill_recommendations/{studentId}  (keyed by studentId — one per student)
 *
 *   student_id       — user ID
 *   top_career       — string (the student's #1 predicted career)
 *   recommended_stream — string
 *   skills           — SkillRecommendation[]
 *   roadmap          — RoadmapStep[]
 *   engine_version   — string
 *   calculated_at    — serverTimestamp
 */
function buildSkillRecommendationDoc(studentId, fields) {
  return {
    student_id:         studentId,
    top_career:         fields.top_career         || null,
    recommended_stream: fields.recommended_stream || null,
    skills:             fields.skills             || [],
    roadmap:            fields.roadmap            || [],
    engine_version:     fields.engine_version     || '1.0.0',
    calculated_at:      null, // set by repository
  };
}

module.exports = {
  COLLECTIONS,
  PROFICIENCY_LEVELS,
  buildStudentSkillDoc,
  buildSkillRecommendationDoc,
};









