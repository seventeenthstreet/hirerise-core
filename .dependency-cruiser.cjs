/**
 * core/.dependency-cruiser.cjs
 *
 * Foundation enforcement — static dependency graph validation for core/.
 *
 * APPROVED RULES — Foundation Phase:
 *   no-circular                       — circular imports
 *   no-repository-importing-service   — repositories must not import services/engines
 *   no-repository-importing-engine    — repositories must not import engines
 *   no-engine-importing-service       — engines must not import services
 *   no-controller-importing-repository — controllers delegate to services only
 *   no-controller-importing-engine    — controllers must not import engines
 *
 * RUN:
 *   npx depcruise src --config .dependency-cruiser.cjs
 *
 * GOVERNANCE: Doc 08 — Dependency Rules
 *
 * COMPATIBILITY: dependency-cruiser ^16.x
 *   `outputType` is a CLI flag — it is NOT a valid options field in v16.
 *   Use `--output-type err-long` on the command line instead.
 */

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [

    // ── Circular dependencies ─────────────────────────────────────────────────
    {
      name:     'no-circular',
      severity: 'error',
      from:     {},
      to:       { circular: true },
    },

    // ── Repository layer ceiling ──────────────────────────────────────────────
    // Repositories are pure database adapters. They must not import from
    // services or engines — that would invert the dependency direction.
    {
      name:     'no-repository-importing-service',
      severity: 'error',
      from:     { path: '\\.repository\\.js$' },
      to:       { path: '\\.service\\.js$' },
    },
    {
      name:     'no-repository-importing-engine',
      severity: 'error',
      from:     { path: '\\.repository\\.js$' },
      to:       { path: '\\.engine\\.js$' },
    },

    // ── Engine layer ceiling ──────────────────────────────────────────────────
    // Engines compute; they do not orchestrate. Engines must not import services.
    {
      name:     'no-engine-importing-service',
      severity: 'error',
      from:     { path: '\\.engine\\.js$' },
      to:       { path: '\\.service\\.js$' },
    },

    // ── Controller layer isolation ────────────────────────────────────────────
    // Controllers receive HTTP, delegate to exactly one service, return.
    // Direct repository or engine access in controllers bypasses the service
    // layer and makes business logic invisible.
    {
      name:     'no-controller-importing-repository',
      severity: 'error',
      from:     { path: '\\.controller\\.js$' },
      to:       { path: '\\.repository\\.js$' },
    },
    {
      name:     'no-controller-importing-engine',
      severity: 'error',
      from:     { path: '\\.controller\\.js$' },
      to:       { path: '\\.engine\\.js$' },
    },

  ],

  options: {
    doNotFollow: {
      path: 'node_modules',
    },
    exclude: {
      path: '^(dist|coverage|src/quarantine)/',
    },
    moduleSystems: ['cjs', 'es6'],
    // NOTE: outputType is a CLI flag, not a config field.
    // Pass it via the npm script: depcruise src --output-type err-long --config ...
  },
};
