'use strict';

/**
 * local/no-engine-importing-engine
 *
 * Prevents a *.engine.js file from requiring another *.engine.js file.
 * Engines are atomic computation units — all coordination belongs in services.
 *
 * BAD (in src/modules/career-readiness/deterministic.engine.js):
 *   const chiEngine = require('../chiV2/chiV2.engine');
 *
 * GOOD — the service layer coordinates:
 *   // career-readiness.service.js
 *   const chiScore   = await chiEngine.score(userId);
 *   const readiness  = await readinessEngine.evaluate(chiScore);
 *
 * WHY:
 *   Engines receive pre-computed inputs from their owning service. When
 *   engines import siblings they create an implicit execution graph that
 *   lives outside service visibility, making the dependency chain opaque
 *   to both static analysis and operational observability.
 *
 * DETECTION:
 *   Flags require() calls inside *.engine.js files whose argument string
 *   ends with .engine or .engine.js.
 *
 * SEVERITY: error
 * AUTOFIX:  no
 * GOVERNANCE: Doc 08 — Dependency Rules
 */

const path = require('path');

const ENGINE_FILE_RE   = /\.engine\.js$/;
const ENGINE_IMPORT_RE = /\.engine(\.js)?$/;

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow *.engine.js files from requiring sibling *.engine.js files.',
    },
    messages: {
      noEngineImportingEngine:
        '"{{importer}}" must not import sibling engine "{{imported}}". ' +
        'Engines are atomic — they must not coordinate with each other. ' +
        'The owning service should call each engine in sequence, ' +
        'passing results as arguments. ' +
        '[Doc 08 — Dependency Rules]',
    },
    schema: [],
  },

  create(context) {
    const filename = context.getFilename().replace(/\\/g, '/');

    // Rule is only active inside engine files
    if (!ENGINE_FILE_RE.test(filename)) {
      return {};
    }

    const importerBasename = path.basename(filename);

    function checkRequireSource(sourceValue, reportNode) {
      if (!sourceValue.startsWith('.')) return;
      if (!ENGINE_IMPORT_RE.test(sourceValue)) return;

      context.report({
        node: reportNode,
        messageId: 'noEngineImportingEngine',
        data: {
          importer: importerBasename,
          imported: path.basename(sourceValue),
        },
      });
    }

    return {
      // ESM
      ImportDeclaration(node) {
        checkRequireSource(node.source.value, node);
      },

      // CJS
      CallExpression(node) {
        if (
          node.callee.type === 'Identifier' &&
          node.callee.name === 'require' &&
          node.arguments.length === 1 &&
          node.arguments[0].type === 'Literal' &&
          typeof node.arguments[0].value === 'string'
        ) {
          checkRequireSource(node.arguments[0].value, node);
        }
      },
    };
  },
};
