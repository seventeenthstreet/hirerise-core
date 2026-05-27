'use strict';

/**
 * src/services/careerPath.utils.js
 *
 * Utility re-export for careerPath functions.
 *
 * simulation.service cannot import careerPath.service directly per governance
 * Doc 08 — Dependency Rules. This utility wrapper is the governed boundary.
 */

const careerPathService = require('./careerPath.service');

module.exports = careerPathService;
