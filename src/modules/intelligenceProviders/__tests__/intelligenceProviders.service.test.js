'use strict';

/**
 * intelligenceProviders.service.test.js — WP-ADMIN-INTEL-06
 *
 * Verifies the core safety property this whole feature hinges on:
 * registering a provider is NOT the same as it being executable, and the
 * service reports that honestly. Repository, credential gateway, and the
 * built-in secrets gateway are all mocked — this suite is about service
 * *logic*, not persistence or encryption.
 */

const mockFindAll = jest.fn();
const mockFindByKey = jest.fn();
const mockCreate = jest.fn();
const mockUpdate = jest.fn();
const mockDeleteByKey = jest.fn();

jest.mock('../intelligenceProviders.repository', () => ({
  findAll: (...args) => mockFindAll(...args),
  findByKey: (...args) => mockFindByKey(...args),
  create: (...args) => mockCreate(...args),
  update: (...args) => mockUpdate(...args),
  deleteByKey: (...args) => mockDeleteByKey(...args),
}));

const mockSaveCredential = jest.fn();
const mockGetCredentialStatus = jest.fn();
const mockDeleteCredential = jest.fn();

jest.mock('../intelligenceProviders.secrets', () => ({
  saveCredential: (...args) => mockSaveCredential(...args),
  getCredentialStatus: (...args) => mockGetCredentialStatus(...args),
  deleteCredential: (...args) => mockDeleteCredential(...args),
}));

const mockGetProviderStatus = jest.fn();
jest.mock('../../intelligenceSecrets/intelligenceSecrets.config', () => ({
  getProviderStatus: (...args) => mockGetProviderStatus(...args),
}));

const mockLogAdminAction = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../utils/adminAuditLogger', () => ({
  logAdminAction: (...args) => mockLogAdminAction(...args),
}));

const service = require('../intelligenceProviders.service');

function builtinStatus(overrides = {}) {
  return {
    provider: 'openai',
    secretName: 'OPENAI_API_KEY',
    environmentConfigured: false,
    secretsManagerConfigured: false,
    configured: false,
    ...overrides,
  };
}

describe('intelligenceProviders.service — isRuntimeSupported', () => {
  it('is true for every built-in provider key', () => {
    expect(service.isRuntimeSupported('openai')).toBe(true);
    expect(service.isRuntimeSupported('gemini')).toBe(true);
    expect(service.isRuntimeSupported('anthropic')).toBe(true);
  });

  it('is false for a genuinely new provider key — no adapter shipped for it', () => {
    expect(service.isRuntimeSupported('cohere')).toBe(false);
    expect(service.isRuntimeSupported('together_ai')).toBe(false);
  });
});

describe('intelligenceProviders.service — listProviders', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetProviderStatus.mockImplementation((key) => Promise.resolve(builtinStatus({ provider: key })));
    mockFindAll.mockResolvedValue([]);
  });

  it('lists all five built-ins even with no custom providers registered', async () => {
    const { providers } = await service.listProviders();
    const builtinKeys = providers.filter((p) => p.builtIn).map((p) => p.providerKey).sort();
    expect(builtinKeys).toEqual(['anthropic', 'gemini', 'grok', 'mistral', 'openai']);
    expect(providers.every((p) => p.builtIn && p.runtimeSupported)).toBe(true);
  });

  it('marks a registered custom provider as NOT runtime-supported ("adapter unavailable") even when its credential is configured', async () => {
    mockFindAll.mockResolvedValue([
      {
        providerKey: 'cohere',
        displayName: 'Cohere',
        adapterType: 'openai',
        apiEndpoint: 'https://api.cohere.ai/v1/chat',
        defaultModel: 'command-r',
        credentialType: 'api_key',
        enabled: true,
        priorityPosition: 0,
        metadata: {},
        createdAt: '2026-08-24T00:00:00.000Z',
        updatedAt: '2026-08-24T00:00:00.000Z',
      },
    ]);
    mockGetCredentialStatus.mockResolvedValue({ secretName: 'INTEL_PROVIDER_COHERE_API_KEY', configured: true });

    const { providers } = await service.listProviders();
    const cohere = providers.find((p) => p.providerKey === 'cohere');

    expect(cohere.builtIn).toBe(false);
    expect(cohere.credentialConfigured).toBe(true);
    expect(cohere.runtimeSupported).toBe(false);
    expect(cohere.runtimeStatus).toBe('adapter_unavailable');
  });

  it('reports not_configured for a custom provider with no credential yet', async () => {
    mockFindAll.mockResolvedValue([
      {
        providerKey: 'cohere',
        displayName: 'Cohere',
        adapterType: 'openai',
        apiEndpoint: null,
        defaultModel: null,
        credentialType: 'api_key',
        enabled: true,
        priorityPosition: 0,
        metadata: {},
        createdAt: null,
        updatedAt: null,
      },
    ]);
    mockGetCredentialStatus.mockResolvedValue({ secretName: 'INTEL_PROVIDER_COHERE_API_KEY', configured: false });

    const { providers } = await service.listProviders();
    const cohere = providers.find((p) => p.providerKey === 'cohere');
    expect(cohere.runtimeStatus).toBe('not_configured');
  });
});

describe('intelligenceProviders.service — addProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindByKey.mockResolvedValue(null);
    mockFindAll.mockResolvedValue([]);
    mockGetCredentialStatus.mockResolvedValue({ secretName: 'INTEL_PROVIDER_COHERE_API_KEY', configured: true });
  });

  it('rejects duplicate provider keys', async () => {
    mockFindByKey.mockResolvedValue({ providerKey: 'cohere' });
    await expect(
      service.addProvider({ providerKey: 'cohere', displayName: 'Cohere', adapterType: 'openai' }, undefined, 'admin-1')
    ).rejects.toMatchObject({ status: 409, code: 'DUPLICATE_PROVIDER_KEY' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects invalid input before ever touching the repository', async () => {
    await expect(
      service.addProvider({ providerKey: 'openai', displayName: 'x', adapterType: 'openai' }, undefined, 'admin-1')
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_INPUT' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('creates the row, stores the credential when supplied, and never puts it in the audit log', async () => {
    mockCreate.mockResolvedValue({
      providerKey: 'cohere',
      displayName: 'Cohere',
      adapterType: 'openai',
      apiEndpoint: null,
      defaultModel: null,
      credentialType: 'api_key',
      enabled: true,
      priorityPosition: 0,
      metadata: {},
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
    });
    mockSaveCredential.mockResolvedValue({ providerKey: 'cohere', secretName: 'INTEL_PROVIDER_COHERE_API_KEY', preview: 'sk-a****', updatedAt: 'now' });

    const result = await service.addProvider(
      { providerKey: 'cohere', displayName: 'Cohere', adapterType: 'openai' },
      'sk-abcdef123456',
      'admin-1'
    );

    expect(mockCreate).toHaveBeenCalled();
    expect(mockSaveCredential).toHaveBeenCalledWith('cohere', 'sk-abcdef123456', 'admin-1');
    expect(result.runtimeSupported).toBe(false);

    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const auditCall = mockLogAdminAction.mock.calls[0][0];
    expect(auditCall.action).toBe('INTELLIGENCE_PROVIDER_CREATE');
    expect(JSON.stringify(auditCall.metadata)).not.toMatch(/sk-abcdef123456/);
  });
});

describe('intelligenceProviders.service — mutating a built-in provider through this API', () => {
  it('updateProvider refuses to touch a built-in provider key', async () => {
    await expect(service.updateProvider('openai', { enabled: false }, 'admin-1')).rejects.toMatchObject({
      status: 400,
      code: 'BUILTIN_PROVIDER_KEY',
    });
  });

  it('setCredential refuses to touch a built-in provider key', async () => {
    await expect(service.setCredential('openai', 'sk-x', 'admin-1')).rejects.toMatchObject({
      status: 400,
      code: 'BUILTIN_PROVIDER_KEY',
    });
  });

  it('removeProvider refuses to touch a built-in provider key', async () => {
    await expect(service.removeProvider('openai', 'admin-1')).rejects.toMatchObject({
      status: 400,
      code: 'BUILTIN_PROVIDER_KEY',
    });
  });
});

describe('intelligenceProviders.service — removeProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('deletes the credential and the registry row, and audits without leaking a secret', async () => {
    mockFindByKey.mockResolvedValue({ providerKey: 'cohere', displayName: 'Cohere', adapterType: 'openai' });
    mockDeleteCredential.mockResolvedValue({ providerKey: 'cohere', secretName: 'INTEL_PROVIDER_COHERE_API_KEY' });
    mockDeleteByKey.mockResolvedValue(true);

    await service.removeProvider('cohere', 'admin-1');

    expect(mockDeleteCredential).toHaveBeenCalledWith('cohere', 'admin-1');
    expect(mockDeleteByKey).toHaveBeenCalledWith('cohere');
    expect(mockLogAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'INTELLIGENCE_PROVIDER_DELETE', entityId: 'cohere' })
    );
  });

  it('404s when the provider does not exist', async () => {
    mockFindByKey.mockResolvedValue(null);
    await expect(service.removeProvider('does-not-exist-key', 'admin-1')).rejects.toMatchObject({ status: 404 });
  });
});
