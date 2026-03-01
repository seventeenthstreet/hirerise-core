// /modules/skill-prioritization/index.js
// Wires up dependencies and exports the configured engine instance.

const SkillPrioritizationEngine = require("../../intelligence/skill-prioritization.engine");
const roleSkillMatrixRepo = require("../../repositories/roleSkillMatrix.repository");
const careerGraphRepo     = require("../../repositories/careerGraph.repository");
const skillMarketRepo     = require("../../repositories/skillMarket.repository");
const userRepo            = require("../../repositories/user.repository");

const engine = new SkillPrioritizationEngine({
  roleSkillMatrixRepo,
  careerGraphRepo,
  skillMarketRepo,
  userRepo,
});

module.exports = engine;

// ─── Controller usage ────────────────────────────────────────────────────────
// const engine = require("./modules/skill-prioritization");
// const result = await engine.run(req.body, { isPremium: req.user.isPremium });
// res.json({ success: true, data: result });