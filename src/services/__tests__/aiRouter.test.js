'use strict';

/**
 * src/services/__tests__/aiRouter.test.js
 *
 * Production-grade integration tests for the multi-provider AI Router
 * Fully isolated from Firebase, external SDKs, and real network traffic.
 */

const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const ROUTER_PATH = path.resolve(__dirname, '../aiRouter');
const PROVIDERS_DIR = path.resolve(__dirname, '../providers');
const SECRETS_MODULE_PATH = path.resolve(
  __dirname,
  '../../modules/secrets/index.js'
);
const SECRETS_BARREL_PATH = path.resolve(
  __dirname,
  '../../modules/secrets'
);

// ─────────────────────────────────────────────────────────────────────────────
// Controlled test state
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let secretBehaviour = 'return';

// ─────────────────────────────────────────────────────────────────────────────
// Test utilities
// ─────────────────────────────────────────────────────────────────────────────

function assert(condition, message = 'Assertion failed') {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      message ||
        `Expected ${JSON.stringify(actual)} === ${JSON.stringify(expected)}`
    );
  }
}

async function test(label, fn) {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
    passed++;
  } catch (error) {
    failed++;
    console.error(`  ✗ ${label}`);
    console.error(`    ${error instanceof Error ? error.message : error}`);
  }
}

function resetEnv(overrides = {}) {
  delete process.env.AI_FAILURE_THRESHOLD;
  delete process.env.AI_COOLDOWN_MS;
  delete process.env.AI_PROVIDER_TIMEOUT_MS;

  Object.assign(process.env, overrides);
}

function clearModuleCache() {
  for (const key of Object.keys(require.cache)) {
    if (
      key.includes('aiRouter') ||
      key.includes(`${path.sep}providers${path.sep}`) ||
      key.includes(`${path.sep}modules${path.sep}secrets`)
    ) {
      delete require.cache[key];
    }
  }
}

function injectSecretsMock() {
  const mock = {
    getSecret: async (name) => {
      if (secretBehaviour === 'throw') {
        const error = new Error(`Secret not found: ${name}`);
        error.statusCode = 404;
        throw error;
      }

      return `fake-key-for-${name}`;
    },
  };

  require.cache[SECRETS_MODULE_PATH] = {
    id: SECRETS_MODULE_PATH,
    filename: SECRETS_MODULE_PATH,
    loaded: true,
    exports: mock,
  };

  require.cache[SECRETS_BARREL_PATH] =
    require.cache[SECRETS_MODULE_PATH];
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider mock factory
// ─────────────────────────────────────────────────────────────────────────────

function registerFakeProvider(providerFile, behaviour) {
  const fullPath = path.resolve(PROVIDERS_DIR, providerFile);
  const providerName = providerFile.replace('Service.js', '');

  require.cache[fullPath] = {
    id: fullPath,
    filename: fullPath,
    loaded: true,
    exports: {
      PROVIDER_NAME: providerName,
      generate: async () => {
        switch (behaviour) {
          case 'failure':
            throw new Error(`${providerFile} simulated failure`);

          case 'empty-text':
            return { provider: providerName, text: '' };

          case 'timeout':
            await new Promise(() => {});
            return null;

          default:
            return {
              provider: providerName,
              text: `Response from ${providerFile}`,
            };
        }
      },
    },
  };
}

function registerAllProviders(
  gemini,
  fireworks,
  mistral,
  openrouter,
  claude
) {
  registerFakeProvider('geminiService.js', gemini);
  registerFakeProvider('fireworksService.js', fireworks);
  registerFakeProvider('mistralService.js', mistral);
  registerFakeProvider('openrouterService.js', openrouter);
  registerFakeProvider('claudeService.js', claude);
}

function loadFreshRouter() {
  injectSecretsMock();
  delete require.cache[ROUTER_PATH];
  return require(ROUTER_PATH);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n══════════════════════════════════════════════');
  console.log('  AI Router — Integration Tests');
  console.log('══════════════════════════════════════════════\n');

  // Suite 1
  console.log('Suite 1: Primary provider succeeds');
  clearModuleCache();
  resetEnv();
  registerAllProviders('success', 'failure', 'failure', 'failure', 'failure');

  {
    const { generateAIResponse, getProviderHealth } = loadFreshRouter();
    const result = await generateAIResponse('Hello');

    await test('returns Gemini response', () => {
      assert(result.includes('geminiService'));
    });

    await test('health returns 5 providers', () => {
      assertEqual(getProviderHealth().length, 5);
    });
  }

  // Suite 2
  console.log('\nSuite 2: Fallback chain');
  clearModuleCache();
  resetEnv();
  registerAllProviders('failure', 'success', 'failure', 'failure', 'failure');

  {
    const { generateAIResponse, getProviderHealth } = loadFreshRouter();
    const result = await generateAIResponse('Hello');

    await test('falls back to Fireworks', () => {
      assert(result.includes('fireworksService'));
    });

    await test('Gemini failure tracked', () => {
      const gemini = getProviderHealth().find((p) => p.name === 'Gemini');
      assertEqual(gemini.failures, 1);
    });
  }

  // Suite 3
  console.log('\nSuite 3: Claude last resort');
  clearModuleCache();
  resetEnv();
  registerAllProviders('failure', 'failure', 'failure', 'failure', 'success');

  {
    const { generateAIResponse } = loadFreshRouter();
    const result = await generateAIResponse('Prompt');

    await test('reaches Claude', () => {
      assert(result.includes('claudeService'));
    });
  }

  // Suite 4
  console.log('\nSuite 4: Graceful degradation');
  clearModuleCache();
  resetEnv();
  registerAllProviders('failure', 'failure', 'failure', 'failure', 'failure');

  {
    const { generateAIResponse } = loadFreshRouter();
    const result = await generateAIResponse('Prompt');

    await test('returns fallback string', () => {
      assertEqual(result, 'AI service temporarily unavailable.');
    });
  }

  // Suite 5
  console.log('\nSuite 5: Health threshold');
  clearModuleCache();
  resetEnv({
    AI_FAILURE_THRESHOLD: '2',
    AI_COOLDOWN_MS: '60000',
  });
  registerAllProviders('failure', 'success', 'failure', 'failure', 'failure');

  {
    const { generateAIResponse, getProviderHealth } = loadFreshRouter();

    await generateAIResponse('first');
    await generateAIResponse('second');

    const gemini = getProviderHealth().find((p) => p.name === 'Gemini');

    await test('Gemini marked down', () => {
      assertEqual(gemini.status, 'down');
    });
  }

  // Suite 6
  console.log('\nSuite 6: Timeout protection');
  clearModuleCache();
  resetEnv({
    AI_PROVIDER_TIMEOUT_MS: '100',
  });
  registerAllProviders('timeout', 'success', 'failure', 'failure', 'failure');

  {
    const { generateAIResponse } = loadFreshRouter();

    const start = Date.now();
    const result = await generateAIResponse('Prompt');
    const elapsed = Date.now() - start;

    await test('timeout triggers fallback', () => {
      assert(result.includes('fireworksService'));
    });

    await test('timeout bounded', () => {
      assert(elapsed < 3000);
    });
  }

  // Suite 7
  console.log('\nSuite 7: Empty response fallback');
  clearModuleCache();
  resetEnv();
  registerAllProviders('empty-text', 'success', 'failure', 'failure', 'failure');

  {
    const { generateAIResponse } = loadFreshRouter();
    const result = await generateAIResponse('Prompt');

    await test('empty text skipped', () => {
      assert(result.includes('fireworksService'));
    });
  }

  // Suite 8
  console.log('\nSuite 8: Input validation');
  clearModuleCache();
  resetEnv();
  registerAllProviders('success', 'success', 'success', 'success', 'success');

  {
    const { generateAIResponse } = loadFreshRouter();

    await test('throws on empty string', async () => {
      let threw = false;
      try {
        await generateAIResponse('');
      } catch {
        threw = true;
      }
      assert(threw);
    });

    await test('throws on null', async () => {
      let threw = false;
      try {
        await generateAIResponse(null);
      } catch {
        threw = true;
      }
      assert(threw);
    });
  }

  // Suite 9
  console.log('\nSuite 9: Secret module failure');
  clearModuleCache();
  resetEnv();
  secretBehaviour = 'throw';
  registerAllProviders('failure', 'failure', 'failure', 'failure', 'failure');

  {
    const { generateAIResponse } = loadFreshRouter();
    const result = await generateAIResponse('Hello');

    await test('secret failure degrades safely', () => {
      assertEqual(result, 'AI service temporarily unavailable.');
    });
  }

  secretBehaviour = 'return';

  // Summary
  console.log('\n══════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('══════════════════════════════════════════════\n');

  if (failed > 0) {
    throw new Error(`${failed} tests failed`);
  }
}

runTests().catch((error) => {
  console.error('\nTest runner crashed:', error);
  process.exit(1);
});