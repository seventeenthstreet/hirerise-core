'use strict';

/**
 * src/modules/opportunityRadar/opportunityRadar.service.js
 *
 * Thin service layer between opportunityRadar.controller and opportunityRadar.engine.
 *
 * Ownership:
 *   opportunityRadar.controller
 *       ↓
 *   opportunityRadar.service
 *       ↓
 *   opportunityRadar.engine
 *
 * Constraints:
 *   - No business logic added here; delegates to engine
 *   - No service → service imports
 *   - Explicit method mapping only; no generic runners
 */

const engine = require('../../engines/opportunityRadar.engine');

/**
 * Get personalised opportunity radar results for an authenticated user.
 *
 * @param {string} userId
 * @param {{ topN: number, minOpportunityScore: number, minMatchScore: number }} opts
 * @returns {Promise<object>}
 */
async function getOpportunityRadar(userId, opts = {}) {
  return engine.getOpportunityRadar(userId, opts);
}

/**
 * Return the public catalogue of top emerging career roles.
 *
 * @param {{ limit: number, industry: string|null, emergingOnly: boolean, minScore: number }} opts
 * @returns {Promise<object>}
 */
async function getEmergingRoles(opts = {}) {
  // Delegates to engine; engine owns the data access and filtering logic.
  return engine.getEmergingRoles(opts);
}

/**
 * Trigger a full refresh of opportunity signals from LMI data.
 * Admin-only operation; auth guard is enforced at the controller.
 *
 * @returns {Promise<object>}
 */
async function detectOpportunitySignals() {
  return engine.detectOpportunitySignals();
}

module.exports = {
  getOpportunityRadar,
  getEmergingRoles,
  detectOpportunitySignals,
};
