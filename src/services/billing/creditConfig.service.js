'use strict';

/**
 * src/config/creditConfig.js
 * Production-ready immutable credit cost configuration
 */

const CREDIT_CONFIG = Object.freeze({
  costs: Object.freeze({
    fullAnalysis: 10,
    generateCV: 5,
    jobMatchAnalysis: 8,
  }),
});

function getCreditConfig() {
  return CREDIT_CONFIG;
}

module.exports = {
  getCreditConfig,
  CREDIT_CONFIG,
};