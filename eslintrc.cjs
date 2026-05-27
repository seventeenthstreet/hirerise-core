'use strict';

/**
 * .eslintrc.cjs — HireRise backend ESLint configuration
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRACT DRIFT PREVENTION
 * ─────────────────────────────────────────────────────────────────────────────
 * The `local/no-inline-res-json` rule is the primary drift-prevention mechanism
 * for the V2 API response contract.
 *
 * WHY inline res.json() is dangerous in application routes:
 *   - It bypasses the shared sendSuccess/sendError helpers which guarantee:
 *       • { success: boolean }          — required discriminant
 *       • { data: ... }                 — always present on success
 *       • { error: { code, message } }  — V2 error shape on failure
 *       • { meta: { timestamp, requestId } }  — standard meta envelope
 *   - Inline responses drift: every author writes a slightly different shape
 *   - Drift causes parseBackendError to hit legacy/transitional branches
 *   - Accumulated drift is what Phase 2 was designed to eliminate
 *   - Without enforcement, Phase 3 branches can never be safely removed
 *
 * EXEMPTION POLICY:
 *   To exempt a handler, add this comment inside the function body:
 *     // CONTRACT EXEMPTION: <TYPE>
 *   Valid types and their rationale are documented in docs/api-contract-exemptions.md
 *   Common types: HEALTH_PROBE, WEBHOOK_ACK, SSE_STREAM, BINARY_DOWNLOAD
 *
 * ESCALATION PATH:
 *   This rule is set to 'warn' during the observation window.
 *   After 14-day clean observation period (see Phase 3 gate criteria),
 *   escalate to 'error' to make CI hard-fail on violations.
 *   TODO(phase3-cleanup): Change 'warn' → 'error' after observation window closes.
 * ─────────────────────────────────────────────────────────────────────────────
 */

module.exports = {
  root: true,

  env: {
    node:  true,
    es2022: true,
  },

  parserOptions: {
    ecmaVersion: 2022,
    sourceType:  'commonjs',
  },

  // ── Plugin registration ───────────────────────────────────────────────────
  // The local plugin lives at src/eslint-plugin-local.
  // ESLint resolves plugin paths relative to the config file location.
  plugins: ['local'],

  // ── Rule activation ───────────────────────────────────────────────────────
  rules: {
    // CONTRACT ENFORCEMENT: Prevent inline res.json() in application routes.
    //
    // Start as WARN (not ERROR) during the observation window.
    // The goal is visibility before hard enforcement.
    // Escalate to 'error' after Phase 3 gate criteria are met.
    //
    // To suppress for an intentionally exempt handler, add inside the function:
    //   // CONTRACT EXEMPTION: HEALTH_PROBE   (or WEBHOOK_ACK, SSE_STREAM, etc.)
    // See docs/api-contract-exemptions.md for the full exemption registry.
    'local/no-inline-res-json': 'warn',
  },

  // ── File-level overrides ──────────────────────────────────────────────────
  overrides: [
    {
      // The shared response helper itself uses res.json() — that's the implementation.
      // ESLint must not flag the implementation of the rule it is enforcing.
      files: ['src/shared/response/index.js'],
      rules: { 'local/no-inline-res-json': 'off' },
    },
    {
      // Health probe routes are intentionally non-V2 (HEALTH_PROBE exemption).
      // File-level exclusion is belt-and-suspenders alongside inline comments.
      files: [
        'src/routes/health.routes.js',
        'api-service/src/routes/health.routes.js',
      ],
      rules: { 'local/no-inline-res-json': 'off' },
    },
    {
      // Webhook ACK routes are intentionally non-V2 (WEBHOOK_ACK exemption).
      files: ['src/routes/webhooks.routes.js'],
      rules: { 'local/no-inline-res-json': 'off' },
    },
    {
      // Test files are allowed to construct any shape for assertion purposes.
      files: ['**/*.test.js', '**/*.spec.js', 'tests/**/*.js'],
      rules: { 'local/no-inline-res-json': 'off' },
    },
  ],
};
