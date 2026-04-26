'use strict';

/**
 * @file src/services/ai/index.js
 * @description
 * Public API surface for the AI Provider domain.
 * Application code should only import from this module boundary.
 *
 * Example usage (in onboarding.controller.js or aiExtractor.service.js):
 *
 *   const { extractResumeWithFallback } = require('../services/ai');
 *
 *   const result = await extractResumeWithFallback(rawResumeText);
 *   if (!result) {
 *     // All AI providers failed — fall back to rule-based parse only
 *   }
 */

const {
  extractResumeWithFallback,
  isValidAIResult,
  getProviderPriority,
} = require('./aiProviderManager');

module.exports = Object.freeze({
  extractResumeWithFallback,
  isValidAIResult,
  getProviderPriority,
});