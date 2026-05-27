'use strict';

/**
 * eslint-plugin-local (backend)
 *
 * Drop-in replacement for core/src/eslint-plugin-local/index.js.
 * Retains the existing no-inline-res-json rule and adds two
 * layer-isolation rules for the foundation enforcement phase.
 *
 * APPROVED RULES — Foundation Phase:
 *   no-inline-res-json           — (existing) restrict inline res.json() patterns
 *   no-service-importing-service — services must not import sibling services
 *   no-engine-importing-engine   — engines must not import sibling engines
 *
 * USAGE in core/eslintrc.cjs — add to rules:
 *   'local/no-service-importing-service': 'error',
 *   'local/no-engine-importing-engine':   'error',
 */

module.exports = {
  rules: {
    // Existing rule — preserve as-is
    'no-inline-res-json': require('./rules/no-inline-res-json'),

    // Foundation phase additions (v3 — hardened path normalization + allowlists)
    // lib/rules/ contains the governance-stabilized versions with coordinator
    // pairs, infrastructure primitive exemptions, and quarantine exclusions.
    'no-service-importing-service': require('./lib/rules/no-service-importing-service'),
    'no-engine-importing-engine':   require('./rules/no-engine-importing-engine'),
  },
};
