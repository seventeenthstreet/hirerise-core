'use strict';

/**
 * eslint-plugin-local/rules/no-inline-res-json.js
 *
 * Prevents inline res.json() / res.status(N).json() in application routes,
 * enforcing use of sendSuccess / sendError from src/shared/response.
 *
 * INSTALL:
 *   Place this file at: eslint-plugin-local/rules/no-inline-res-json.js
 *   Add to .eslintrc:
 *     plugins: ['local'],
 *     rules: { 'local/no-inline-res-json': 'warn' }
 *
 * EXEMPTION:
 *   Add the comment // CONTRACT EXEMPTION: <TYPE> anywhere in the function
 *   to suppress this rule for that handler.
 *
 * FILES EXCLUDED (via .eslintrc overrides):
 *   - src/shared/response/index.js  (the helper itself)
 *   - src/routes/health.routes.js   (HEALTH_PROBE exemption)
 *   - src/routes/webhooks.routes.js (WEBHOOK_ACK exemption)
 *   - api-service/src/routes/health.routes.js
 */

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow inline res.json() in application routes. Use sendSuccess/sendError from shared/response.',
      url: 'docs/api-contract-exemptions.md',
    },
    messages: {
      noInlineResJson:
        'Use sendSuccess() or sendError() from shared/response instead of inline res.json(). ' +
        'If this endpoint is intentionally exempt (health probe, webhook ACK, SSE, binary stream), ' +
        'add a comment: // CONTRACT EXEMPTION: <TYPE>  — see docs/api-contract-exemptions.md',
    },
    schema: [],
  },

  create(context) {
    return {
      CallExpression(node) {
        // Match: res.json(...) or res.status(N).json(...)
        const isResJson =
          node.callee.type === 'MemberExpression' &&
          node.callee.property.name === 'json' &&
          (
            // res.json(...)
            (
              node.callee.object.type === 'Identifier' &&
              node.callee.object.name === 'res'
            ) ||
            // res.status(N).json(...)
            (
              node.callee.object.type === 'CallExpression' &&
              node.callee.object.callee?.type === 'MemberExpression' &&
              node.callee.object.callee?.object?.name === 'res' &&
              node.callee.object.callee?.property?.name === 'status'
            )
          );

        if (!isResJson) return;

        // Check for CONTRACT EXEMPTION comment in the same function scope
        const sourceCode = context.getSourceCode();
        const ancestors = context.getAncestors();

        // Walk up to the nearest function body and scan its comments
        for (let i = ancestors.length - 1; i >= 0; i--) {
          const ancestor = ancestors[i];
          if (
            ancestor.type === 'FunctionDeclaration' ||
            ancestor.type === 'FunctionExpression' ||
            ancestor.type === 'ArrowFunctionExpression'
          ) {
            const functionText = sourceCode.getText(ancestor);
            if (functionText.includes('CONTRACT EXEMPTION')) return;
            break;
          }
        }

        // Also check if in a file that's in the allowed list
        const filename = context.getFilename();
        const allowedFiles = [
          'shared/response/index.js',
          'shared/response\\index.js',
          'health.routes.js',
          'webhooks.routes.js',
        ];
        if (allowedFiles.some(f => filename.includes(f))) return;

        context.report({ node, messageId: 'noInlineResJson' });
      },
    };
  },
};