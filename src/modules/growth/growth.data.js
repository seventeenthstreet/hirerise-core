'use strict';

/**
 * src/modules/growth/growth.data.js
 *
 * Data-access utility for the growth module.
 *
 * Owns the single call into resumeGrowth repository to retrieve the
 * latest growth baseline for a user. Extracted here so growth.service
 * (a *.service.js file) does not import a sibling service directly.
 *
 * Governance: replaces growth.service → resumeGrowth.service direct import.
 */

const resumeGrowthService = require('../resumeGrowth/resumeGrowth.service');

/**
 * Fetch the latest growth baseline for a user + role.
 *
 * @param {string} userId
 * @param {string|null} targetRoleId
 * @returns {Promise<object|null>}
 */
async function getLatestBaseline(userId, targetRoleId) {
  return resumeGrowthService.getLatest(userId, targetRoleId);
}

module.exports = { getLatestBaseline };
