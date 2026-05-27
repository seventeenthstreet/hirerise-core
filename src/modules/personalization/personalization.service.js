'use strict';

/**
 * src/modules/personalization/personalization.service.js
 *
 * Thin service layer between personalization.controller and aiPersonalization.engine.
 *
 * Ownership:
 *   personalization.controller
 *       ↓
 *   personalization.service
 *       ↓
 *   aiPersonalization.engine
 *
 * Constraints:
 *   - No business logic added here; delegates to engine
 *   - No service → service imports
 *   - Explicit method mapping only; no generic runners
 */

const engine = require('../../engines/aiPersonalization.engine');
const { getUserVector, updateUserVector } = require('../../services/userVector.utils');

const vectorOps = { getUserVector, updateUserVector };

/**
 * Get personalised career recommendations for a user.
 *
 * @param {string} userId
 * @param {{ topN: number, forceRefresh: boolean }} opts
 * @returns {Promise<object>}
 */
async function recommendPersonalizedCareers(userId, opts = {}) {
  const profile = await engine.loadUserProfile(userId, vectorOps);
  return engine.upsertPersonalizationProfile(userId, profile, vectorOps);
}

/**
 * Record a user behavior event.
 *
 * @param {string} userId
 * @param {object} eventPayload
 * @returns {Promise<object>}
 */
async function trackBehaviorEvent(userId, eventPayload) {
  return engine.trackBehaviorEvent(userId, eventPayload);
}

/**
 * Retrieve the current personalization profile for a user.
 *
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
async function getPersonalizationProfile(userId) {
  return engine.getPersonalizationProfile(userId);
}

/**
 * Recompute and persist the behavior-derived profile for a user.
 *
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
async function updateBehaviorProfile(userId) {
  const profile = await engine.loadUserProfile(userId, vectorOps);
  return engine.upsertPersonalizationProfile(userId, profile, vectorOps);
}

module.exports = {
  recommendPersonalizedCareers,
  trackBehaviorEvent,
  getPersonalizationProfile,
  updateBehaviorProfile,
};