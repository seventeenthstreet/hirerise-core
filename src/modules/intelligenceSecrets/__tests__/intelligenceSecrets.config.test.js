'use strict';

/**
 * intelligenceSecrets.config.test.js — WP-ADMIN-INTEL-03
 *
 * Unit tests for the Intelligence secret configuration gateway. All
 * Secrets Manager calls are mocked — this suite verifies gateway *logic*
 * (provider registry derivation, alias-aware status, canonical-only
 * writes, unknown-provider rejection, no-plaintext guarantees), not the
 * underlying encryption (already covered by secrets.service's own module).
 */

const mockUpsertSecret = jest.fn();
const mockGetSecretStatus = jest.fn();
const mockDeleteSecret = jest.fn();

jest.mock('../../secrets/secrets.service', () => ({
  upsertSecret: (...args) => mockUpsertSecret(...args),
  getSecretStatus: (...args) => mockGetSecretStatus(...args),
  deleteSecret: (...args) => mockDeleteSecret(...args),
}));

// Real aiProviderManager is used for PROVIDER_ENV_KEYS — it has no
// Supabase/network dependency of its own, so no mock is needed here.
const gateway = require('../intelligenceSecrets.config');
const { PROVIDER_ENV_KEYS } = require('../../../services/ai/aiProviderManager');

function notFoundError() {
  return Object.assign(new Error('not found'), { status: 404 });
}

describe('intelligenceSecrets.config — provider registry', () => {
  it('derives its provider registry from aiProviderManager.PROVIDER_ENV_KEYS', () => {
    expect(gateway.listProviderIds().sort()).toEqual(
      Object.keys(PROVIDER_ENV_KEYS).sort()
    );
  });

  it('sets canonicalName to the first env var and aliasNames to the rest', () => {
    expect(gateway.PROVIDERS.grok).toEqual({
      canonicalName: 'GROK_API_KEY',
      aliasNames: ['XAI_API_KEY'],
    });
    expect(gateway.PROVIDERS.anthropic).toEqual({
      canonicalName: 'ANTHROPIC_API_KEY',
      aliasNames: [],
    });
  });

  it('isSupportedProvider is true only for registered providers', () => {
    expect(gateway.isSupportedProvider('anthropic')).toBe(true);
    expect(gateway.isSupportedProvider('not-a-real-provider')).toBe(false);
    expect(gateway.isSupportedProvider('__proto__')).toBe(false);
    expect(gateway.isSupportedProvider(undefined)).toBe(false);
  });
});

describe('intelligenceSecrets.config — getProviderStatus', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GROK_API_KEY;
    delete process.env.XAI_API_KEY;
  });

  it('rejects an unknown provider with a safe 400', async () => {
    await expect(gateway.getProviderStatus('made-up')).rejects.toMatchObject({
      status: 400,
      code: 'UNKNOWN_PROVIDER',
    });
    expect(mockGetSecretStatus).not.toHaveBeenCalled();
  });

  it('reports configured=false when neither env nor Secrets Manager has it', async () => {
    mockGetSecretStatus.mockRejectedValue(notFoundError());

    const status = await gateway.getProviderStatus('anthropic');

    expect(status).toEqual({
      provider: 'anthropic',
      secretName: 'ANTHROPIC_API_KEY',
      environmentConfigured: false,
      secretsManagerConfigured: false,
      configured: false,
    });
  });

  it('reports environmentConfigured=true when the env var is set, without calling getSecret (only status)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-value';
    mockGetSecretStatus.mockRejectedValue(notFoundError());

    const status = await gateway.getProviderStatus('anthropic');

    expect(status.environmentConfigured).toBe(true);
    expect(status.configured).toBe(true);
  });

  it('reports secretsManagerConfigured=true when getSecretStatus resolves for the canonical name', async () => {
    mockGetSecretStatus.mockResolvedValue({
      name: 'ANTHROPIC_API_KEY',
      updatedAt: '2026-01-01T00:00:00.000Z',
      updatedBy: 'admin-1',
    });

    const status = await gateway.getProviderStatus('anthropic');

    expect(status.secretsManagerConfigured).toBe(true);
    expect(status.configured).toBe(true);
    expect(mockGetSecretStatus).toHaveBeenCalledWith('ANTHROPIC_API_KEY');
  });

  it('checks the alias name for grok when the canonical name is not configured', async () => {
    mockGetSecretStatus.mockImplementation((name) => {
      if (name === 'XAI_API_KEY') {
        return Promise.resolve({ name, updatedAt: null, updatedBy: null });
      }
      return Promise.reject(notFoundError());
    });

    const status = await gateway.getProviderStatus('grok');

    expect(status.secretsManagerConfigured).toBe(true);
    expect(status.secretName).toBe('GROK_API_KEY'); // canonical name is still reported
    expect(mockGetSecretStatus).toHaveBeenCalledWith('GROK_API_KEY');
    expect(mockGetSecretStatus).toHaveBeenCalledWith('XAI_API_KEY');
  });

  it('fails safe (treats as not-configured) when getSecretStatus throws an unexpected error', async () => {
    mockGetSecretStatus.mockRejectedValue(new Error('DB unreachable'));

    const status = await gateway.getProviderStatus('anthropic');

    expect(status.secretsManagerConfigured).toBe(false);
  });

  it('never returns a plaintext value, ciphertext, or any Secrets Manager internals', async () => {
    mockGetSecretStatus.mockResolvedValue({
      name: 'ANTHROPIC_API_KEY',
      updatedAt: '2026-01-01T00:00:00.000Z',
      updatedBy: 'admin-1',
    });

    const status = await gateway.getProviderStatus('anthropic');
    const serialized = JSON.stringify(status);

    expect(status).not.toHaveProperty('value');
    expect(status).not.toHaveProperty('encrypted_value');
    expect(status).not.toHaveProperty('iv');
    expect(status).not.toHaveProperty('auth_tag');
    expect(status).not.toHaveProperty('hmac');
    expect(serialized).not.toMatch(/sk-ant|ciphertext/i);
  });
});

describe('intelligenceSecrets.config — listProviderStatuses', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSecretStatus.mockRejectedValue(notFoundError());
  });

  it('returns one status entry per supported provider', async () => {
    const statuses = await gateway.listProviderStatuses();
    expect(statuses.map((s) => s.provider).sort()).toEqual(
      gateway.listProviderIds().sort()
    );
  });
});

describe('intelligenceSecrets.config — saveProviderCredential', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects an unknown provider before calling upsertSecret', async () => {
    await expect(
      gateway.saveProviderCredential('made-up', 'sk-test', 'admin-1')
    ).rejects.toMatchObject({ status: 400, code: 'UNKNOWN_PROVIDER' });
    expect(mockUpsertSecret).not.toHaveBeenCalled();
  });

  it('always writes to the canonical secret name, never a client-supplied name', async () => {
    mockUpsertSecret.mockResolvedValue({
      name: 'GROK_API_KEY',
      preview: 'sk-t****',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    await gateway.saveProviderCredential('grok', 'sk-test-value', 'admin-1');

    expect(mockUpsertSecret).toHaveBeenCalledWith('GROK_API_KEY', 'sk-test-value', 'admin-1');
  });

  it('returns only masked preview + safe metadata — never the submitted value', async () => {
    mockUpsertSecret.mockResolvedValue({
      name: 'ANTHROPIC_API_KEY',
      preview: 'sk-a****',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const result = await gateway.saveProviderCredential(
      'anthropic',
      'sk-ant-super-secret-value',
      'admin-1'
    );

    expect(result).toEqual({
      provider: 'anthropic',
      secretName: 'ANTHROPIC_API_KEY',
      preview: 'sk-a****',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(JSON.stringify(result)).not.toContain('sk-ant-super-secret-value');
  });
});

describe('intelligenceSecrets.config — deleteProviderCredential', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects an unknown provider before calling deleteSecret', async () => {
    await expect(
      gateway.deleteProviderCredential('made-up', 'admin-1')
    ).rejects.toMatchObject({ status: 400, code: 'UNKNOWN_PROVIDER' });
    expect(mockDeleteSecret).not.toHaveBeenCalled();
  });

  it('deletes only the canonical secret name for the given provider', async () => {
    mockDeleteSecret.mockResolvedValue(undefined);

    const result = await gateway.deleteProviderCredential('mistral', 'admin-1');

    expect(mockDeleteSecret).toHaveBeenCalledWith('MISTRAL_API_KEY', 'admin-1');
    expect(mockDeleteSecret).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ provider: 'mistral', secretName: 'MISTRAL_API_KEY' });
  });
});
