// careerReadiness.types.js

/**
 * @typedef {Object} CandidateProfile
 * @property {string} candidateId
 * @property {string[]} skills               - normalized skill slugs
 * @property {number} totalYearsExperience
 * @property {Object[]} workHistory          - [{title, years, skills[]}]
 * @property {string[]} certifications
 * @property {string} highestEducation       - "bachelors"|"masters"|"phd"|"none"
 * @property {number} currentSalary
 * @property {string} targetRoleId
 */

/**
 * @typedef {Object} CareerReadinessResult
 * @property {number} career_readiness_score
 * @property {string} readiness_level
 * @property {Object} dimension_scores
 * @property {Object[]} skill_gaps
 * @property {string[]} strength_areas
 * @property {number} promotion_probability
 * @property {number} salary_positioning_index
 * @property {number} growth_readiness_index
 * @property {Object[]} career_roadmap
 * @property {Object} explainability
 */








