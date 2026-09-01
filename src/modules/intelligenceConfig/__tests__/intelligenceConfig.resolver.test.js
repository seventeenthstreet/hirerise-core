'use strict';

/**
 * intelligenceConfig.resolver.test.js — WP-ADMIN-INTEL-04
 *
 * Verifies the admin-override -> environment -> code-default precedence,
 * in-process caching + invalidation, and fail-safe behavior on a
 * malformed persisted value or a repository error.
 */

const mockFindByKey = jest.fn();

jest.mock('../intelligenceConfig.repository', () => ({
  findByKey: (...args) => mockFindByKey(...args),
}));

const ORIGINAL_ENV = { ...process.env };

let resolver;

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.AI_PROVIDER_PRIORITY;

  // Re-require after resetModules so the module-level cache Map is fresh
  // for every test (this module intentionally keeps in-process state).
  mockFindByKey.mockReset();
  jest.doMock('../intelligenceConfig.repository', () => ({
    findByKey: (...args) => mockFindByKey(...args),
  }));
  resolver = require('../intelligenceConfig.resolver');
});

describe('intelligenceConfig.resolver — precedence', () => {
  it('uses the code default when neither an admin override nor an env value is set', async () => {
    mockFindByKey.mockResolvedValue(null);

    const result = await resolver.resolveEffective('AI_PROVIDER_PRIORITY');

    expect(result.source).toBe('default');
    expect(result.value).toBe('gemini,grok,mistral,openai,anthropic');
  });

  it('uses the environment value when set and no admin override exists', async () => {
    mockFindByKey.mockResolvedValue(null);
    process.env.AI_PROVIDER_PRIORITY = 'openai,anthropic';

    const result = await resolver.resolveEffective('AI_PROVIDER_PRIORITY');

    expect(result.source).toBe('environment');
    expect(result.value).toBe('openai,anthropic');
  });

  it('prefers the admin override over both the environment value and the code default', async () => {
    process.env.AI_PROVIDER_PRIORITY = 'openai,anthropic';
    mockFindByKey.mockResolvedValue({ key: 'AI_PROVIDER_PRIORITY', value: 'gemini,mistral' });

    const result = await resolver.resolveEffective('AI_PROVIDER_PRIORITY');

    expect(result.source).toBe('admin');
    expect(result.value).toBe('gemini,mistral');
  });

  it('rejects an unsupported key', async () => {
    await expect(resolver.resolveEffective('BOGUS')).rejects.toThrow(
      "Unsupported Intelligence configuration key: 'BOGUS'."
    );
  });
});

describe('intelligenceConfig.resolver — fail-safe behavior', () => {
  it('falls back to environment/default when the persisted admin override is malformed', async () => {
    process.env.AI_PROVIDER_PRIORITY = 'openai';
    mockFindByKey.mockResolvedValue({ key: 'AI_PROVIDER_PRIORITY', value: 'not-a-real-provider' });

    const result = await resolver.resolveEffective('AI_PROVIDER_PRIORITY');

    expect(result.source).toBe('environment');
    expect(result.value).toBe('openai');
  });

  it('falls back to environment/default when the repository throws', async () => {
    process.env.AI_PROVIDER_PRIORITY = 'mistral';
    mockFindByKey.mockRejectedValue(new Error('DB unavailable'));

    const result = await resolver.resolveEffective('AI_PROVIDER_PRIORITY');

    expect(result.source).toBe('environment');
    expect(result.value).toBe('mistral');
  });

  it('never throws out of resolveProviderPriority() even on total failure', async () => {
    mockFindByKey.mockRejectedValue(new Error('DB unavailable'));
    // No env var set either — must land on the hard-coded default tier.
    const priority = await resolver.resolveProviderPriority();
    expect(priority).toEqual(['gemini', 'grok', 'mistral', 'openai', 'anthropic']);
  });
});

describe('intelligenceConfig.resolver — caching', () => {
  it('does not re-query the repository on a second resolution within the TTL', async () => {
    mockFindByKey.mockResolvedValue({ key: 'AI_PROVIDER_PRIORITY', value: 'gemini' });

    await resolver.resolveEffective('AI_PROVIDER_PRIORITY');
    await resolver.resolveEffective('AI_PROVIDER_PRIORITY');

    expect(mockFindByKey).toHaveBeenCalledTimes(1);
  });

  it('re-queries after invalidate() with no write-through value', async () => {
    mockFindByKey.mockResolvedValue({ key: 'AI_PROVIDER_PRIORITY', value: 'gemini' });

    await resolver.resolveEffective('AI_PROVIDER_PRIORITY');
    resolver.invalidate('AI_PROVIDER_PRIORITY');
    await resolver.resolveEffective('AI_PROVIDER_PRIORITY');

    expect(mockFindByKey).toHaveBeenCalledTimes(2);
  });

  it('write-through invalidate() is reflected immediately without another repository call', async () => {
    mockFindByKey.mockResolvedValue(null);

    const before = await resolver.resolveEffective('AI_PROVIDER_PRIORITY');
    expect(before.source).toBe('default');

    resolver.invalidate('AI_PROVIDER_PRIORITY', 'openai,gemini');

    const after = await resolver.resolveEffective('AI_PROVIDER_PRIORITY');
    expect(after.source).toBe('admin');
    expect(after.value).toBe('openai,gemini');
    // Only the first resolution should have hit the repository — the
    // write-through value served the second resolution straight from cache.
    expect(mockFindByKey).toHaveBeenCalledTimes(1);
  });

  it('does not cache a transient repository failure (retries on next resolution)', async () => {
    mockFindByKey.mockRejectedValueOnce(new Error('transient'));
    mockFindByKey.mockResolvedValueOnce({ key: 'AI_PROVIDER_PRIORITY', value: 'mistral' });

    const first = await resolver.resolveEffective('AI_PROVIDER_PRIORITY');
    expect(first.source).toBe('default');

    const second = await resolver.resolveEffective('AI_PROVIDER_PRIORITY');
    expect(second.source).toBe('admin');
    expect(second.value).toBe('mistral');

    expect(mockFindByKey).toHaveBeenCalledTimes(2);
  });
});
