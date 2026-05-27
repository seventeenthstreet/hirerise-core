'use strict';

/**
 * local/no-service-importing-service
 *
 * Prevents a *.service.js file from requiring another *.service.js file
 * that is not under a shared/ directory.
 *
 * BAD (in src/modules/dashboard/dashboard.service.js):
 *   const aw = require('../adaptiveWeight/adaptiveWeight.service');
 *
 * GOOD — coordinate through the event bus or extract shared logic to utils/:
 *   const eventBus = require('../../shared/pubsub');
 *
 * WHY:
 *   Direct service-to-service imports create hidden coupling. They prevent
 *   independent testing, bypass dependency injection, and make the call graph
 *   invisible to static analysis. Services coordinate via the event bus or
 *   through a dedicated coordinator; they do not call each other directly.
 *
 * DETECTION:
 *   Flags require() calls inside *.service.js files whose argument string
 *   ends with .service or .service.js, excluding shared/ paths.
 *
 * SEVERITY: error
 * AUTOFIX:  no
 * GOVERNANCE: Doc 08 — Dependency Rules
 */

const path = require('path');

const SERVICE_FILE_RE  = /\.service\.js$/;
const SERVICE_IMPORT_RE = /\.service(\.js)?$/;
const SHARED_PATH_RE   = /[\\/]shared[\\/]/;

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow *.service.js files from requiring sibling *.service.js files.',
    },
    messages: {
      noServiceImportingService:
        '"{{importer}}" must not import sibling service "{{imported}}". ' +
        'Services must not call each other directly. ' +
        'Options: emit a domain event via shared/pubsub, ' +
        'extract shared logic to a utils module, ' +
        'or introduce a coordinator service that owns both calls. ' +
        '[Doc 08 — Dependency Rules]',
    },
    schema: [],
  },

  create(context) {
    const filename = context.getFilename().replace(/\\/g, '/');

    // Rule is only active inside service files
    if (!SERVICE_FILE_RE.test(filename)) {
      return {};
    }

    const importerBasename = path.basename(filename);

    function checkRequireSource(sourceValue, reportNode) {
      // Only relative imports — node_modules are never a governance concern here
      if (!sourceValue.startsWith('.')) return;

      // Must look like a service import
      if (!SERVICE_IMPORT_RE.test(sourceValue)) return;

      // shared/ imports are allowed (infrastructure, not domain services)
      if (SHARED_PATH_RE.test(sourceValue)) return;

      context.report({
        node: reportNode,
        messageId: 'noServiceImportingService',
        data: {
          importer: importerBasename,
          imported: path.basename(sourceValue),
        },
      });
    }

    return {
      // ESM: import x from './foo.service'
      ImportDeclaration(node) {
        checkRequireSource(node.source.value, node);
      },

      // CJS: require('./foo.service') or require('./foo.service.js')
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
