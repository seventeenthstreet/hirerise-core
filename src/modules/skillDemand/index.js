'use strict';

/**
 * skillDemand/index.js — Barrel export for Skill Demand Intelligence
 *
 * Exposes:
 * - Express router
 * - service + repository classes
 * - CHI integration helpers
 * - full analysis helper
 */

const skillDemandRouter = require('./routes/skillDemand.routes');
const { SkillDemandService } = require('./service/skillDemand.service');
const { SkillDemandRepository } = require('./repository/skillDemand.repository');

/**
 * Lazy singleton service instance.
 * Prevents eager side effects during module load.
 *
 * @type {SkillDemandService|null}
 */
let serviceInstance = null;

/**
 * Get shared service instance.
 *
 * @returns {SkillDemandService}
 */
function getService() {
  if (!serviceInstance) {
    serviceInstance = new SkillDemandService();
  }

  return serviceInstance;
}

/**
 * Lightweight CHI adapter.
 *
 * @param {string} role
 * @param {Array<string|{name:string}>} skills
 * @returns {Promise<number>}
 */
async function computeChiSkillScore(role, skills) {
  return getService().computeChiSkillScore(role, skills);
}

/**
 * Internal full analysis helper.
 *
 * @param {Object} params
 * @returns {Promise<Object>}
 */
async function analyzeSkillDemand(params) {
  return getService().analyzeSkillDemand(params);
}

module.exports = {
  skillDemandRouter,
  computeChiSkillScore,
  analyzeSkillDemand,
  SkillDemandService,
  SkillDemandRepository,
};