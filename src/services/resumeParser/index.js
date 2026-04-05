'use strict';

/**
 * services/resumeParser/index.js
 *
 * Public API surface for the Resume Parser domain.
 * Application code must only import from this module boundary.
 *
 * This file intentionally remains infrastructure-agnostic:
 * - no Firebase dependencies
 * - no Supabase dependencies
 * - no provider-specific logic
 *
 * All persistence/provider concerns must stay inside downstream services.
 */

const {
  parseResumeText,
  mapParsedToOnboardingShape,
} = require('./resumeParser.service');

module.exports = Object.freeze({
  parseResumeText,
  mapParsedToOnboardingShape,
});