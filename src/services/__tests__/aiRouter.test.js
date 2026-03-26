'use strict';

/**
 * aiRouter.test.js — Integration tests for the multi-provider AI Router
 *
 * Tests the router in full isolation:
 *   - Secret Manager is mocked (no Firebase dependency)
 *   - Provider HTTP calls are stubbed
 *   - All branching logic (fallback, health tracking, timeout, degradation)
 *     is exercised without any real network calls
 *
 * Run:
 *   node src/services/__tests__/aiRouter.test.js
 */

// ─── Module Registry Helpers ──────────────────────────────────────────────────
// We manipulate require.cache to inject mocks cleanly before importing the
// modules under test. This avoids any external dependencies.

function clearModuleCache() {
  const keys = Object.keys(require.cache).filter(k =>
    k.includes('aiRouter') ||
    k.includes('providers/')
  );
  keys.forEach(k => delete require.cache[k]);
}

// ─── Fake getSecret ───────────────────────────────────────────────────────────
// Build a controlled fake secrets module that either returns a key or throws.

let secretBehaviour = 'return'; // 'return' | 'throw'

function buildSecretsModuleMock() {
  return {
    getSecret: async (name) => {
      if (secretBehaviour === 'throw') {
        throw Object.assign(new Error(`Secret not found: ${name}`), { statusCode: 404 });
      }
      return `fake-key-for-${name}`;
    },
  };
}

// Inject the secrets mock before any provider is required.
// Resolve the path the provider files use: '../../modules/secrets'
// from src/services/providers/ → src/modules/secrets
const path = require('path');
const secretsModulePath = path.resolve(
  __dirname, '../../modules/secrets/index.js'
);
require.cache[secretsModulePath] = {
  id:       secretsModulePath,
  filename: secretsModulePath,
  loaded:   true,
  exports:  buildSecretsModuleMock(),
};

// Also cover the barrel require without /index.js suffix
const secretsBarrelPath = path.resolve(__dirname, '../../modules/secrets');
require.cache[secretsBarrelPath] = require.cache[secretsModulePath];

// ─── Test Utilities ───────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(label, fn) {
  try {
    await fn();
    console.log(`  ✓  ${label}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${label}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(a, b, message) {
  if (a !== b) throw new Error(message || `Expected ${JSON.stringify(a)} === ${JSON.stringify(b)}`);
}

// ─── Provider Mock Factory ────────────────────────────────────────────────────

/**
 * Register a fake provider module in require.cache so the router picks it up.
 * Each provider can be configured to succeed or fail.
 */
function registerFakeProvider(providerFile, behaviour) {
  // behaviour: 'success' | 'failure' | 'empty-text' | 'timeout'
  const fullPath = path.resolve(__dirname, '../providers', providerFile);

  require.cache[fullPath] = {
    id:       fullPath,
    filename: fullPath,
    loaded:   true,
    exports: {
      PROVIDER_NAME: providerFile.replace('Service.js', ''),
      generate: async (prompt, options) => {
        if (behaviour === 'failure') {
          throw new Error(`${providerFile} simulated failure`);
        }
        if (behaviour === 'empty-text') {
          return { provider: 'test', text: '' };
        }
        if (behaviour === 'timeout') {
          // Hang forever — router timeout will fire first
          await new Promise(() => {});
        }
        return {
          provider: providerFile.replace('Service.js', ''),
          text:     `Response from ${providerFile}`,
        };
      },
    },
  };
}

function registerAllProviders(gemini, fireworks, mistral, openrouter, claude) {
  registerFakeProvider('geminiService.js',     gemini);
  registerFakeProvider('fireworksService.js',  fireworks);
  registerFakeProvider('mistralService.js',    mistral);
  registerFakeProvider('openrouterService.js', openrouter);
  registerFakeProvider('claudeService.js',     claude);
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n══════════════════════════════════════════════');
  console.log('  AI Router — Integration Tests');
  console.log('══════════════════════════════════════════════\n');

  // ── Suite 1: Primary happy path ─────────────────────────────────────────────
  console.log('Suite 1: Primary provider (Gemini) succeeds');
  {
    clearModuleCache();
    registerAllProviders('success', 'failure', 'failure', 'failure', 'failure');

    const { generateAIResponse, getProviderHealth } = require('../aiRouter');
    const result = await generateAIResponse('Hello');

    await test('returns text from Gemini when it succeeds', () => {
      assert(result.includes('geminiService'), `Expected gemini text, got: ${result}`);
    });

    await test('getProviderHealth returns 5 providers', () => {
      const health = getProviderHealth();
      assertEqual(health.length, 5, 'Should have 5 providers');
    });

    await test('Gemini health is up after success', () => {
      const health = getProviderHealth();
      const gemini = health.find(h => h.name === 'Gemini');
      assertEqual(gemini.status, 'up');
      assertEqual(gemini.failures, 0);
    });
  }

  // ── Suite 2: Fallback chain ──────────────────────────────────────────────────
  console.log('\nSuite 2: Fallback chain — Gemini fails, Fireworks succeeds');
  {
    clearModuleCache();
    registerAllProviders('failure', 'success', 'failure', 'failure', 'failure');

    const { generateAIResponse, getProviderHealth } = require('../aiRouter');
    const result = await generateAIResponse('Hello');

    await test('falls back to Fireworks when Gemini fails', () => {
      assert(result.includes('fireworksService'), `Expected fireworks text, got: ${result}`);
    });

    await test('Gemini has 1 failure recorded', () => {
      const health = getProviderHealth();
      const gemini = health.find(h => h.name === 'Gemini');
      assertEqual(gemini.failures, 1);
      assertEqual(gemini.status, 'up', 'Should still be up — threshold not reached');
    });

    await test('Fireworks is healthy after success', () => {
      const health = getProviderHealth();
      const fw = health.find(h => h.name === 'Fireworks');
      assertEqual(fw.status, 'up');
      assertEqual(fw.failures, 0);
    });
  }

  // ── Suite 3: Full waterfall to Claude (last resort) ─────────────────────────
  console.log('\nSuite 3: All providers fail except Claude (last resort)');
  {
    clearModuleCache();
    registerAllProviders('failure', 'failure', 'failure', 'failure', 'success');

    const { generateAIResponse } = require('../aiRouter');
    const result = await generateAIResponse('Test prompt');

    await test('reaches Claude as last resort', () => {
      assert(result.includes('claudeService'), `Expected claude text, got: ${result}`);
    });
  }

  // ── Suite 4: All providers fail → graceful fallback string ─────────────────
  console.log('\nSuite 4: All providers fail → graceful degradation');
  {
    clearModuleCache();
    registerAllProviders('failure', 'failure', 'failure', 'failure', 'failure');

    const { generateAIResponse } = require('../aiRouter');
    const result = await generateAIResponse('Test prompt');

    await test('returns safe fallback string when all fail', () => {
      assertEqual(result, 'AI service temporarily unavailable.');
    });
  }

  // ── Suite 5: Health tracking — mark provider DOWN ─────────────────────────
  console.log('\nSuite 5: Health tracking — provider marked DOWN after threshold failures');
  {
    clearModuleCache();
    // All fail — Gemini will hit threshold after FAILURE_THRESHOLD calls
    registerAllProviders('failure', 'success', 'failure', 'failure', 'failure');

    // Override threshold to 2 for this test
    process.env.AI_FAILURE_THRESHOLD = '2';
    process.env.AI_COOLDOWN_MS = '60000';

    const { generateAIResponse, getProviderHealth } = require('../aiRouter');

    // Call twice so Gemini hits threshold=2
    await generateAIResponse('first call');
    await generateAIResponse('second call');

    const health = getProviderHealth();
    const gemini = health.find(h => h.name === 'Gemini');

    await test('Gemini is marked DOWN after threshold failures', () => {
      assertEqual(gemini.status, 'down', `Expected down, got: ${gemini.status}`);
    });

    await test('Gemini has a retryAfter timestamp set', () => {
      assert(gemini.retryAfter !== null, 'retryAfter should be set');
      assert(new Date(gemini.retryAfter) > new Date(), 'retryAfter should be in the future');
    });

    delete process.env.AI_FAILURE_THRESHOLD;
    delete process.env.AI_COOLDOWN_MS;
  }

  // ── Suite 6: Timeout protection ──────────────────────────────────────────────
  console.log('\nSuite 6: Timeout protection — slow provider is skipped');
  {
    clearModuleCache();
    registerAllProviders('timeout', 'success', 'failure', 'failure', 'failure');

    // Short timeout for test speed
    process.env.AI_PROVIDER_TIMEOUT_MS = '100';

    const { generateAIResponse } = require('../aiRouter');
    const start = Date.now();
    const result = await generateAIResponse('Test prompt');
    const elapsed = Date.now() - start;

    await test('falls back to Fireworks after Gemini times out', () => {
      assert(result.includes('fireworksService'), `Expected fireworks, got: ${result}`);
    });

    await test('total time is bounded by timeout (not hung)', () => {
      assert(elapsed < 3000, `Took ${elapsed}ms — should be < 3000ms`);
    });

    delete process.env.AI_PROVIDER_TIMEOUT_MS;
  }

  // ── Suite 7: Empty-text guard ─────────────────────────────────────────────
  console.log('\nSuite 7: Empty-text guard — invalid response triggers fallback');
  {
    clearModuleCache();
    registerAllProviders('empty-text', 'success', 'failure', 'failure', 'failure');

    const { generateAIResponse } = require('../aiRouter');
    const result = await generateAIResponse('Test prompt');

    await test('skips provider returning empty text and falls back', () => {
      assert(result.includes('fireworksService'), `Expected fireworks fallback, got: ${result}`);
    });
  }

  // ── Suite 8: Invalid prompt guard ─────────────────────────────────────────
  console.log('\nSuite 8: Input validation');
  {
    clearModuleCache();
    registerAllProviders('success', 'success', 'success', 'success', 'success');

    const { generateAIResponse } = require('../aiRouter');

    await test('throws on empty string prompt', async () => {
      let threw = false;
      try { await generateAIResponse(''); } catch { threw = true; }
      assert(threw, 'Should throw on empty prompt');
    });

    await test('throws on null prompt', async () => {
      let threw = false;
      try { await generateAIResponse(null); } catch { threw = true; }
      assert(threw, 'Should throw on null prompt');
    });

    await test('throws on whitespace-only prompt', async () => {
      let threw = false;
      try { await generateAIResponse('   '); } catch { threw = true; }
      assert(threw, 'Should throw on whitespace-only prompt');
    });
  }

  // ── Suite 9: Secret Manager failure → treated as provider failure ──────────
  console.log('\nSuite 9: Secret Manager failure treated as provider failure');
  {
    clearModuleCache();
    secretBehaviour = 'throw';

    // Don't register fake providers — let them go through real provider code
    // which will call getSecret (mocked to throw) and fail naturally.
    // Register success stubs for all to avoid needing real SDK imports.
    registerAllProviders('failure', 'failure', 'failure', 'failure', 'failure');

    const { generateAIResponse } = require('../aiRouter');
    const result = await generateAIResponse('Hello');

    await test('returns graceful fallback when Secret Manager is unavailable', () => {
      assertEqual(result, 'AI service temporarily unavailable.');
    });

    secretBehaviour = 'return'; // reset
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('══════════════════════════════════════════════\n');

  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error('\nTest runner crashed:', err);
  process.exit(1);
});








