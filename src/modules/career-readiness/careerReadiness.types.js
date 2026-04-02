"use strict";

/**
 * src/modules/career-readiness/careerReadiness.types.js
 *
 * Centralized JSDoc contracts for:
 * - controller
 * - service
 * - deterministic engine
 * - AI engine
 * - Supabase score persistence
 */

/**
 * @typedef {Object} WorkHistoryEntry
 * @property {string|null} title
 * @property {number} years
 * @property {string[]} skills
 */

/**
 * Canonical validated candidate input profile
 *
 * @typedef {Object} CandidateProfile
 * @property {string} candidateId
 * @property {string[]} skills                     Normalized skill slugs
 * @property {number} totalYearsExperience
 * @property {WorkHistoryEntry[]} workHistory
 * @property {string[]} certifications
 * @property {"bachelors"|"masters"|"phd"|"none"|null} highestEducation
 * @property {number|null} currentSalary
 * @property {string} targetRoleId
 */

/**
 * Final API response contract
 *
 * @typedef {Object} CareerReadinessResult
 * @property {number} career_readiness_score
 * @property {"low"|"medium"|"high"|"excellent"} readiness_level
 * @property {Object<string, number>} dimension_scores
 * @property {Object[]} skill_gaps
 * @property {string[]} strength_areas
 * @property {number} promotion_probability
 * @property {number} salary_positioning_index
 * @property {number} growth_readiness_index
 * @property {Object[]} career_roadmap
 * @property {Object} explainability
 */

/**
 * Live Supabase persistence row contract
 * Table: career_readiness_scores
 *
 * @typedef {Object} CareerReadinessScoreRow
 * @property {string} candidate_id
 * @property {string} role_id
 * @property {number|string} overall_score
 * @property {Object} breakdown
 * @property {string} scored_at
 */

/**
 * Deterministic layer cache payload
 *
 * @typedef {Object} DeterministicResult
 * @property {number} score
 * @property {Object} meta
 */

/**
 * AI engine response contract
 *
 * @typedef {Object} AIResult
 * @property {boolean} success
 * @property {Object} data
 * @property {string=} rawResponse
 * @property {string=} error
 */

module.exports = {};