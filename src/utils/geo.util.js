'use strict';

/**
 * @file src/utils/geo.util.js
 *
 * Geo / country-detection utility.
 * Pure function — no DB, no async, no external IO.
 *
 * Extracted from services/salary.service.js (Phase D, Group A fix #1).
 * Moved here so consumers (jobFetcher.service, etc.) do not need to
 * import the salary domain service for a geography helper.
 */

const logger = require('./logger');

/**
 * Location string → ISO-3166-1 alpha-2 country code lookup.
 * Keep in sync with salary.service.js COUNTRY_CONFIG keys.
 */
const LOCATION_TO_COUNTRY = Object.freeze({
  india:     'IN',
  bangalore: 'IN',
  bengaluru: 'IN',
  dubai:     'AE',
  uae:       'AE',
  usa:       'US',
  us:        'US',
  london:    'GB',
  uk:        'GB',
});

/**
 * Infer a two-letter country code from parsed resume/profile data.
 *
 * Falls back to the DEFAULT_SALARY_COUNTRY env var, then 'IN'.
 *
 * @param {object|null} parsedData  — resume parsed_data object
 * @returns {string}                — uppercase ISO-3166-1 alpha-2 code
 */
function detectUserCountry(parsedData) {
  const defaultCountry = (
    process.env.DEFAULT_SALARY_COUNTRY || 'IN'
  ).toUpperCase();

  if (!parsedData?.location) return defaultCountry;

  const loc = parsedData.location;
  const searchStr =
    typeof loc === 'object'
      ? [loc.country, loc.city].filter(Boolean).join(' ').toLowerCase()
      : String(loc).toLowerCase();

  for (const [key, code] of Object.entries(LOCATION_TO_COUNTRY)) {
    if (searchStr.includes(key)) return code;
  }

  logger.debug('[geo.util] country fallback used', {
    location: loc,
    defaultCountry,
  });

  return defaultCountry;
}

module.exports = {
  detectUserCountry,
  LOCATION_TO_COUNTRY,
};