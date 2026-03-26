'use strict';

/**
 * services/resumeParser/index.js
 *
 * Public API for the Resume Parser Engine.
 * Import from here — never import sub-modules directly from application code.
 */

const { parseResumeText, mapParsedToOnboardingShape } = require('./resumeParser.service');

module.exports = {
  parseResumeText,
  mapParsedToOnboardingShape,
};









