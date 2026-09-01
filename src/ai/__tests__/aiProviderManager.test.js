'use strict';

/**
 * aiProviderManager.test.js — WP-ADMIN-INTEL-03 (G6 fix) + WP-ADMIN-INTEL-04
 *
 * Verifies:
 *   - hasApiKey() stays synchronous-fast when an env var is present (no
 *     Secrets Manager call)
 *   - hasApiKey() falls back to the Secrets Manager when no env var is set
 *     (the G6 fix itself — this is the behavior that was previously missing)
 *   - alias handling for grok (GROK_API_KEY canonical, XAI_API_KEY alias)
 *   - a Secrets-Manager-only-configured provider is no longer silently
 *     skipped by extractResumeWithFallback
 *   - missing credentials (neither env nor Secrets Manager) still correctly
 *     make a provider unavailable
 *   - a Secrets Manager lookup failure fails safe (treated as unavailable,
 *     never thrown) and never logs/exposes the credential
 *   - existing env-only regression behavior (priority parsing, provider
 *     loop, validation) is unchanged
 *   - WP-ADMIN-INTEL-04: extractResumeWithFallback() consults the
 *     Intelligence config resolver (admin override tier) and falls back to
 *     the original getProviderPriority() when the resolver is unavailable
 *     or fails — see "AI_PROVIDER_PRIORITY admin-override integration"
 *     below. The Intelligence config resolver is mocked for this entire
 *     file: it talks to Supabase, and this suite must stay fast/offline
 *     regardless of whether that module is exercised.
 */

const mockGetSecret = jest.fn();
// Toggled (not re-mocked) by the "module unavailable" test below — using
// jest.doMock there instead would permanently replace this factory for
// every subsequent test in the file (doMock registrations outlive
// jest.resetModules(), which only clears the module *instance* cache).
let mockSecretsModuleAvailable = true;

jest.mock('../../../modules/secrets', () => {
  if (!mockSecretsModuleAvailable) {
    throw new Error('Cannot find module (simulated unavailable)');
  }
  return { getSecret: (...args) => mockGetSecret(...args) };
});

// WP-ADMIN-INTEL-04 — mocked for the whole file (see file header). Default:
// rejects, so every pre-existing test below exercises the exact same
// getProviderPriority()-only fallback path it always has. Overridden with
// jest.doMock + jest.resetModules() in the dedicated integration describe
// block further down for the cases that need it to actually resolve.
const mockResolveProviderPriority = jest.fn();
let mockConfigResolverModuleAvailable = true;

jest.mock('../../../modules/intelligenceConfig/intelligenceConfig.resolver', () => {
  if (!mockConfigResolverModuleAvailable) {
    throw new Error('Cannot find module (simulated unavailable)');
  }
  return { resolveProviderPriority: (...args) => mockResolveProviderPriority(...args) };
});

jest.mock('../providers/anthropic', () => ({
  PROVIDER_NAME: 'anthropic',
  extractResume: jest.fn(),
}));
jest.mock('../providers/openai', () => ({
  PROVIDER_NAME: 'openai',
  extractResume: jest.fn(),
}));
jest.mock('../providers/gemini', () => ({
  PROVIDER_NAME: 'gemini',
  extractResume: jest.fn(),
}));
jest.mock('../providers/grok', () => ({
  PROVIDER_NAME: 'grok',
  extractResume: jest.fn(),
}));
jest.mock('../providers/mistral', () => ({
  PROVIDER_NAME: 'mistral',
  extractResume: jest.fn(),
}));

const ORIGINAL_ENV = { ...process.env };

function clearProviderEnv() {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GROK_API_KEY;
  delete process.env.XAI_API_KEY;
  delete process.env.MISTRAL_API_KEY;
  delete process.env.AI_PROVIDER_PRIORITY;
}

let aiProviderManager;
let anthropicProvider;

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  process.env = { ...ORIGINAL_ENV };
  clearProviderEnv();

  // Default: resolver "unavailable" from extractResumeWithFallback's point
  // of view (rejects), so every test that doesn't explicitly configure it
  // falls straight through to the original, unchanged getProviderPriority()
  // path — see file header.
  mockResolveProviderPriority.mockRejectedValue(
    new Error('resolver mocked unavailable in this suite')
  );

  // Re-require after resetModules so the module-level `getSecret` optional
  // require picks up the mock fresh each test.
  aiProviderManager = require('../aiProviderManager');
  anthropicProvider = require('../providers/anthropic');
});

afterEach(() => {
  mockSecretsModuleAvailable = true;
  mockConfigResolverModuleAvailable = true;
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('hasApiKey — env fast path (regression, unchanged)', () => {
  it('returns true immediately when the env var is set, without calling getSecret', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env-value';

    const result = await aiProviderManager.hasApiKey('anthropic');

    expect(result).toBe(true);
    expect(mockGetSecret).not.toHaveBeenCalled();
  });

  it('returns false when no env var and no Secrets Manager module is available', async () => {
    mockSecretsModuleAvailable = false;
    jest.resetModules();
    const freshManager = require('../aiProviderManager');

    const result = await freshManager.hasApiKey('anthropic');
    expect(result).toBe(false);

    mockSecretsModuleAvailable = true; // restore for subsequent tests
  });
});

describe('hasApiKey — G6 fix: Secrets Manager fallback', () => {
  it('returns true when only the Secrets Manager has the credential (previously silently skipped)', async () => {
    mockGetSecret.mockResolvedValue('sk-ant-from-secrets-manager');

    const result = await aiProviderManager.hasApiKey('anthropic');

    expect(result).toBe(true);
    expect(mockGetSecret).toHaveBeenCalledWith('ANTHROPIC_API_KEY');
  });

  it('returns false when neither env nor Secrets Manager has the credential', async () => {
    mockGetSecret.mockRejectedValue(new Error("Secret 'ANTHROPIC_API_KEY' not found."));

    const result = await aiProviderManager.hasApiKey('anthropic');

    expect(result).toBe(false);
  });

  it('checks GROK_API_KEY then XAI_API_KEY (canonical then alias) via the Secrets Manager', async () => {
    mockGetSecret.mockImplementation((name) => {
      if (name === 'XAI_API_KEY') return Promise.resolve('xai-secret-value');
      return Promise.reject(new Error('not found'));
    });

    const result = await aiProviderManager.hasApiKey('grok');

    expect(result).toBe(true);
    expect(mockGetSecret).toHaveBeenCalledWith('GROK_API_KEY');
    expect(mockGetSecret).toHaveBeenCalledWith('XAI_API_KEY');
  });

  it('fails safe (returns false, does not throw) when the Secrets Manager lookup errors unexpectedly', async () => {
    mockGetSecret.mockRejectedValue(new Error('Supabase unreachable'));

    await expect(aiProviderManager.hasApiKey('anthropic')).resolves.toBe(false);
  });

  it('never returns the resolved credential itself — only a boolean', async () => {
    mockGetSecret.mockResolvedValue('sk-ant-should-never-leak');

    const result = await aiProviderManager.hasApiKey('anthropic');

    expect(typeof result).toBe('boolean');
    expect(JSON.stringify(result)).not.toContain('sk-ant-should-never-leak');
  });
});

describe('extractResumeWithFallback — G6 regression: Secrets-Manager-only provider is used, not skipped', () => {
  it('calls the provider module when its credential exists only in the Secrets Manager', async () => {
    process.env.AI_PROVIDER_PRIORITY = 'anthropic';
    mockGetSecret.mockResolvedValue('sk-ant-from-secrets-manager');

    anthropicProvider.extractResume.mockResolvedValue({
      name: 'Jane Doe',
      email: 'jane@example.com',
      skills: ['a', 'b', 'c'],
      experience: [{ title: 'Engineer' }],
      education: [],
    });

    const result = await aiProviderManager.extractResumeWithFallback('some resume text');

    expect(anthropicProvider.extractResume).toHaveBeenCalled();
    expect(result).not.toBeNull();
    expect(result.skills).toEqual(['a', 'b', 'c']);
  });

  it('still skips a provider with no credential anywhere (env or Secrets Manager)', async () => {
    process.env.AI_PROVIDER_PRIORITY = 'anthropic';
    mockGetSecret.mockRejectedValue(new Error('not found'));

    const result = await aiProviderManager.extractResumeWithFallback('some resume text');

    expect(anthropicProvider.extractResume).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('still uses an env-configured provider without touching the Secrets Manager (regression)', async () => {
    process.env.AI_PROVIDER_PRIORITY = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env-value';

    anthropicProvider.extractResume.mockResolvedValue({
      name: null,
      email: null,
      skills: ['x', 'y', 'z'],
      experience: [],
      education: [],
    });

    const result = await aiProviderManager.extractResumeWithFallback('some resume text');

    expect(mockGetSecret).not.toHaveBeenCalled();
    expect(result.skills).toEqual(['x', 'y', 'z']);
  });
});

describe('getProviderPriority — regression, unchanged', () => {
  it('falls back to the documented default order', () => {
    expect(aiProviderManager.getProviderPriority()).toEqual([
      'gemini', 'grok', 'mistral', 'openai', 'anthropic',
    ]);
  });

  it('respects AI_PROVIDER_PRIORITY and filters unknown provider names', () => {
    process.env.AI_PROVIDER_PRIORITY = 'anthropic,not-a-provider,openai';
    expect(aiProviderManager.getProviderPriority()).toEqual(['anthropic', 'openai']);
  });
});

describe('extractResumeWithFallback — AI_PROVIDER_PRIORITY admin-override integration (WP-ADMIN-INTEL-04)', () => {
  it('uses the order returned by the config resolver when it resolves successfully', async () => {
    process.env.AI_PROVIDER_PRIORITY = 'openai'; // would be used if the resolver were ignored
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env-value';
    mockResolveProviderPriority.mockResolvedValue(['anthropic']);

    anthropicProvider.extractResume.mockResolvedValue({
      name: null,
      email: null,
      skills: ['a', 'b', 'c'],
      experience: [],
      education: [],
    });

    const result = await aiProviderManager.extractResumeWithFallback('some resume text');

    expect(mockResolveProviderPriority).toHaveBeenCalled();
    expect(anthropicProvider.extractResume).toHaveBeenCalled();
    expect(result.skills).toEqual(['a', 'b', 'c']);
  });

  it('falls back to getProviderPriority() (env/default) when the resolver rejects', async () => {
    process.env.AI_PROVIDER_PRIORITY = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env-value';
    mockResolveProviderPriority.mockRejectedValue(new Error('DB unavailable'));

    anthropicProvider.extractResume.mockResolvedValue({
      name: null,
      email: null,
      skills: ['a', 'b', 'c'],
      experience: [],
      education: [],
    });

    const result = await aiProviderManager.extractResumeWithFallback('some resume text');

    expect(anthropicProvider.extractResume).toHaveBeenCalled();
    expect(result.skills).toEqual(['a', 'b', 'c']);
  });

  it('falls back to getProviderPriority() (env/default) when the config resolver module cannot be loaded at all', async () => {
    mockConfigResolverModuleAvailable = false;
    jest.resetModules();
    const freshManager = require('../aiProviderManager');
    const freshAnthropic = require('../providers/anthropic');

    process.env.AI_PROVIDER_PRIORITY = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env-value';

    freshAnthropic.extractResume.mockResolvedValue({
      name: null,
      email: null,
      skills: ['a', 'b', 'c'],
      experience: [],
      education: [],
    });

    const result = await freshManager.extractResumeWithFallback('some resume text');

    expect(freshAnthropic.extractResume).toHaveBeenCalled();
    expect(result.skills).toEqual(['a', 'b', 'c']);

    mockConfigResolverModuleAvailable = true; // restore for subsequent tests
  });

  it('does not regress G6: a Secrets-Manager-only provider is still tried when the resolver drives priority', async () => {
    mockResolveProviderPriority.mockResolvedValue(['anthropic']);
    mockGetSecret.mockResolvedValue('sk-ant-from-secrets-manager');

    anthropicProvider.extractResume.mockResolvedValue({
      name: null,
      email: null,
      skills: ['a', 'b', 'c'],
      experience: [],
      education: [],
    });

    const result = await aiProviderManager.extractResumeWithFallback('some resume text');

    expect(anthropicProvider.extractResume).toHaveBeenCalled();
    expect(result.skills).toEqual(['a', 'b', 'c']);
  });
});

describe('isValidAIResult — regression, unchanged', () => {
  it('accepts a result with >=3 skills', () => {
    expect(aiProviderManager.isValidAIResult({ skills: ['a', 'b', 'c'], experience: [] })).toBe(true);
  });

  it('accepts a result with >=1 experience entry', () => {
    expect(aiProviderManager.isValidAIResult({ skills: [], experience: [{}] })).toBe(true);
  });

  it('rejects null, arrays, and thin results', () => {
    expect(aiProviderManager.isValidAIResult(null)).toBe(false);
    expect(aiProviderManager.isValidAIResult([])).toBe(false);
    expect(aiProviderManager.isValidAIResult({ skills: ['a'], experience: [] })).toBe(false);
  });
});
