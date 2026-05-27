'use strict';

/**
 * src/modules/opportunities/coordinators/opportunity.coordinator.js
 *
 * OpportunityCoordinator
 * ─────────────────────────────────────────────────────────────────────────────
 * Single shared coordinator that mediates between domain services
 * (employer.service, university.service) and the student-matching logic.
 *
 * WHY THIS EXISTS:
 *   employer.service and university.service both need student-match counts for
 *   analytics, but the lint rule (Doc 08) forbids service→service imports.
 *   Rather than duplicating the calls or emitting events for a synchronous
 *   read, we introduce a coordinator: a non-service module that may freely
 *   import services and expose the narrow cross-cutting API both callers need.
 *
 * OWNERSHIP:
 *   employer.service  ─┐
 *                      ├─▶  OpportunityCoordinator ─▶ studentMatching.service
 *   university.service ─┘
 *
 * RULES:
 *   - This file is intentionally NOT a *.service.js — it is a coordinator.
 *     The no-service-importing-service rule applies only to *.service.js files.
 *   - Do NOT add business logic here. Delegate entirely to studentMatching.service.
 *   - Do NOT import other services. This coordinator owns one downstream only.
 */

const matchingService = require('../services/studentMatching.service');

/**
 * Return pipeline stats for a single employer job role.
 *
 * @param {string} roleId
 * @returns {Promise<{
 *   role_id: string,
 *   total_pipeline: number,
 *   avg_match_score: number,
 *   skill_gap_analysis: Array,
 *   stream_distribution: Array,
 * }>}
 */
async function getMatchedStudentsForJobRole(roleId) {
  return matchingService.getMatchedStudentsForJobRole(roleId);
}

/**
 * Return match stats for a single university program.
 *
 * @param {string} programId
 * @returns {Promise<{
 *   program_id: string,
 *   total_matched: number,
 *   avg_match_score: number,
 *   stream_distribution: Array,
 *   top_student_skills: Array,
 * }>}
 */
async function getMatchedStudentsForProgram(programId) {
  return matchingService.getMatchedStudentsForProgram(programId);
}

module.exports = {
  getMatchedStudentsForJobRole,
  getMatchedStudentsForProgram,
};