'use strict';

/**
 * @file src/shared/constants/index.js
 * @description Shared immutable constants used across career projection,
 * growth modeling, and progression services.
 */

const MAX_PROJECTION_YEARS = 20;
const DEFAULT_PROJECTION_YEARS = 5;

const DEFAULT_SKILL_COVERAGE = 0.3;
const DEFAULT_PROMOTION_SCORE = 30;

const LEVELS = Object.freeze([
  'Junior',
  'Mid',
  'Senior',
  'Lead',
  'Principal',
]);

module.exports = Object.freeze({
  MAX_PROJECTION_YEARS,
  DEFAULT_PROJECTION_YEARS,
  DEFAULT_SKILL_COVERAGE,
  DEFAULT_PROMOTION_SCORE,
  LEVELS,
});