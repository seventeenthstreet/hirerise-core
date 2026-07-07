'use strict';

/**
 * modules/knowledge-runtime/__tests__/responseContractGovernance.test.js
 *
 * WP-XAI2-02 (Response Contract Governance) — automated drift prevention.
 *
 * Statically scans every controller in `knowledge-runtime/**` and asserts:
 *   1. No controller defines its own local `sendSuccess`/`sendSuccess(res,`
 *      function — every success envelope must come from the repository's
 *      single canonical helper, `src/shared/response`.
 *   2. Every controller that sends a success response actually imports
 *      that canonical helper.
 *
 * This does not execute any controller or mock any service — it is a
 * source-level check, in the same spirit as `ruleLabelCoverage.test.js`
 * (WP-XAI2-01B), so it stays cheap and has no upstream test dependencies.
 * It intentionally does NOT check error-response helpers: `sendNotFound`
 * remains a locally-defined, documented exception in `knowledge.controller.js`
 * and `studentIntelligence.controller.js` (see their module headers) until a
 * dedicated, separately-reviewed error-contract migration is scoped.
 */

const fs = require('fs');
const path = require('path');

const KNOWLEDGE_RUNTIME_DIR = path.join(__dirname, '..');

function findControllerFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      results.push(...findControllerFiles(full));
    } else if (entry.isFile() && /\.controller\.js$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

describe('Response Contract Governance (WP-XAI2-02) — no locally duplicated success envelopes', () => {
  const controllerFiles = findControllerFiles(KNOWLEDGE_RUNTIME_DIR);

  it('finds at least one controller file (sanity check that the scan itself works)', () => {
    expect(controllerFiles.length).toBeGreaterThan(0);
  });

  it.each(controllerFiles.map((f) => [path.relative(KNOWLEDGE_RUNTIME_DIR, f), f]))(
    '%s does not define a local sendSuccess implementation',
    (_label, filePath) => {
      const source = fs.readFileSync(filePath, 'utf8');
      const definesLocalSendSuccess = /function\s+sendSuccess\s*\(/.test(source);
      expect(definesLocalSendSuccess).toBe(false);
    }
  );

  it.each(controllerFiles.map((f) => [path.relative(KNOWLEDGE_RUNTIME_DIR, f), f]))(
    '%s imports the canonical shared response helper if it sends a success response',
    (_label, filePath) => {
      const source = fs.readFileSync(filePath, 'utf8');
      const sendsSuccess = /\bsendSuccess\s*\(/.test(source);
      if (!sendsSuccess) return; // controller has no success path (not expected today, but not this test's concern)

      const importsCanonicalHelper = /require\(['"].*shared\/response['"]\)/.test(source);
      expect(importsCanonicalHelper).toBe(true);
    }
  );
});
