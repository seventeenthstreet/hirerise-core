'use strict';

/**
 * skillDemand/index.js — Barrel export for the Skill Demand Intelligence Engine
 *
 * Provides the Express router and internal service for CHI integration.
 *
 * Mount in server.js:
 *   const { skillDemandRouter } = require('./modules/skillDemand');
 *   app.use(`${API_PREFIX}/skills`, authenticate, skillDemandRouter);
 *
 * Use in CHI engine:
 *   const { computeChiSkillScore } = require('./modules/skillDemand');
 *   const skillScore = await computeChiSkillScore(role, userSkills);
 *
 * @module modules/skillDemand
 */

const router  = require('./routes/skillDemand.routes');
const { SkillDemandService }    = require('./service/skillDemand.service');
const { SkillDemandRepository } = require('./repository/skillDemand.repository');

const _serviceInstance = new SkillDemandService();

/**
 * computeChiSkillScore(role, skills) — CHI integration helper
 *
 * Lightweight adapter used by the CHI engine to get a skill score
 * without going through the full HTTP layer.
 *
 * @param {string}   role
 * @param {string[]} skills
 * @returns {Promise<number>} 0–100
 */
async function computeChiSkillScore(role, skills) {
  return _serviceInstance.computeChiSkillScore(role, skills);
}

/**
 * analyzeSkillDemand({ role, skills }) — Full analysis helper
 *
 * Internal use. Returns complete SkillDemandResult without HTTP overhead.
 *
 * @param {Object} params
 * @returns {Promise<SkillDemandResult>}
 */
async function analyzeSkillDemand(params) {
  return _serviceInstance.analyzeSkillDemand(params);
}

module.exports = {
  skillDemandRouter: router,
  computeChiSkillScore,
  analyzeSkillDemand,
  SkillDemandService,
  SkillDemandRepository,
};








