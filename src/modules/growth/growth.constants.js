'use strict';

/**
 * Immutable salary bands used by growth projections.
 *
 * Current assumptions:
 * - USD yearly salary
 * - role-level global average bands
 * - overlapping edges intentionally allowed for realistic transitions
 */
const SALARY_BANDS = Object.freeze({
  junior: Object.freeze({
    min: 40000,
    max: 65000
  }),

  mid: Object.freeze({
    min: 65000,
    max: 95000
  }),

  senior: Object.freeze({
    min: 95000,
    max: 140000
  }),

  lead: Object.freeze({
    min: 130000,
    max: 180000
  }),

  principal: Object.freeze({
    min: 170000,
    max: 230000
  })
});

module.exports = {
  SALARY_BANDS
};