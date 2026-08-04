'use strict';

/**
 * @file core/src/modules/snapshot-intelligence/computation/__tests__/computation.moduleImport.test.js
 * KR-02C — Snapshot Computation Engine — barrel export & scope-constraint
 * tests.
 *
 * The second describe block below is an automated version of what
 * KR-02B-01's own Traceability Matrix recorded as "verified by
 * inspection" for its own zero-infrastructure exit criterion — this
 * work package makes the same check a running test instead, scanning
 * every non-test source file under computation/ for the forbidden
 * terms KR-02C's own "Explicit Constraints" section names.
 */

const fs = require('fs');
const path = require('path');

const computation = require('../index');

describe('computation barrel export', () => {
  it('exports the engine, context factory, result factories, rule contract, and aggregation/pipeline/validation namespaces', () => {
    expect(typeof computation.SnapshotComputationEngine).toBe('function');
    expect(typeof computation.createSnapshotComputationContext).toBe('function');
    expect(typeof computation.createSnapshotComputationResult).toBe('function');
    expect(typeof computation.createSnapshotComputationSummary).toBe('function');
    expect(typeof computation.createSnapshotComputationStatistics).toBe('function');
    expect(typeof computation.createSnapshotComputationDiagnostics).toBe('function');
    expect(typeof computation.SnapshotComputationRule).toBe('function');
    expect(typeof computation.createRuleSet).toBe('function');
    expect(typeof computation.executeRules).toBe('function');
    expect(typeof computation.aggregation.reduceValues).toBe('function');
    expect(typeof computation.pipeline.createDefaultComputationPipeline).toBe('function');
    expect(typeof computation.validation.validateComputationInput).toBe('function');
  });

  it('exports the full computation error hierarchy', () => {
    expect(typeof computation.SnapshotComputationError).toBe('function');
    expect(typeof computation.SnapshotComputationValidationError).toBe('function');
    expect(typeof computation.SnapshotRuleExecutionError).toBe('function');
    expect(typeof computation.SnapshotAggregationError).toBe('function');
  });

  it('is reachable from the module root barrel export', () => {
    // eslint-disable-next-line global-require
    const moduleRoot = require('../../index');
    expect(moduleRoot.computation).toBeDefined();
    expect(moduleRoot.computation.SnapshotComputationEngine).toBe(computation.SnapshotComputationEngine);
    // KR-02A / KR-02B-01 exports remain untouched
    expect(moduleRoot.domain).toBeDefined();
    expect(moduleRoot.repository).toBeDefined();
  });
});

describe('KR-02C explicit scope constraints (static source inspection)', () => {
  const sourceDir = path.join(__dirname, '..');

  function collectSourceFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'testHelpers') return [];
        return collectSourceFiles(fullPath);
      }
      return entry.name.endsWith('.js') ? [fullPath] : [];
    });
  }

  const files = collectSourceFiles(sourceDir);
  const combinedSource = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  // Strip block and line comments before scanning for forbidden
  // *business* terms — this file's (and the module's own) JSDoc
  // prose legitimately quotes KR-02C's own "Do NOT implement" list
  // when explaining why a given file has no such logic; only actual
  // code (identifiers, string literals, imports) matters for this
  // check.
  const codeOnlySource = combinedSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  // KR-02C Mission: "SHALL NOT: persist data / call databases / call
  // APIs / perform orchestration / execute AI models / generate
  // narratives / invoke LLMs / perform scheduling / perform
  // asynchronous processing"
  const forbiddenInfrastructureTerms = [
    'supabase', 'postgres', 'ioredis', 'redis', 'axios',
    'express', 'graphql', 'openai', '@anthropic-ai', 'setTimeout', 'setInterval',
  ];

  forbiddenInfrastructureTerms.forEach((term) => {
    it(`contains no reference to forbidden infrastructure term "${term}"`, () => {
      expect(combinedSource.toLowerCase()).not.toContain(term.toLowerCase());
    });
  });

  it('never imports the repository layer (zero repository mutations / zero repository coupling)', () => {
    expect(codeOnlySource).not.toMatch(/require\(['"][^'"]*\/repository[^'"]*['"]\)/);
  });

  it('contains no async function declarations or await expressions', () => {
    expect(combinedSource).not.toMatch(/\basync\s+function\b/);
    expect(combinedSource).not.toMatch(/\basync\s*\(/);
    expect(combinedSource).not.toMatch(/\bawait\b/);
  });

  it('contains no Promise construction', () => {
    expect(combinedSource).not.toMatch(/new Promise\(/);
  });

  // KR-02C Explicit Constraints: "Do NOT implement: Business scoring /
  // Career scoring / CHI / AI / LLMs / Prompting / Narrative generation
  // / Recommendations / Resume analysis / Opportunity matching /
  // Knowledge Runtime"
  const forbiddenBusinessTerms = [
    'careerhealthindex', 'chiscore', 'career_health', 'resumescore', 'opportunitymatch',
    'knowledgeruntime', 'llm', 'prompt', 'narrative',
  ];

  forbiddenBusinessTerms.forEach((term) => {
    it(`contains no business-specific concept "${term}"`, () => {
      expect(codeOnlySource.toLowerCase()).not.toContain(term.toLowerCase());
    });
  });
});
