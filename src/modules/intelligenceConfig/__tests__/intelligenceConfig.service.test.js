'use strict';

/**
 * intelligenceConfig.service.test.js — WP-ADMIN-INTEL-04
 *
 * Verifies:
 *   - unknown keys are rejected before the repository is ever touched
 *   - invalid values are rejected before the repository is ever touched
 *   - a successful update persists the normalized value, invalidates the
 *     resolver cache (write-through), and writes a safe audit record
 *   - a reset deletes the override, invalidates the cache, and audits
 *   - no secret values ever enter the audit metadata (there are none to
 *     leak in this domain, but the shape is asserted regardless)
 */

const mockFindByKey = jest.fn();
const mockUpsert = jest.fn();
const mockDeleteByKey = jest.fn();

jest.mock('../intelligenceConfig.repository', () => ({
  findByKey: (...args) => mockFindByKey(...args),
  upsert: (...args) => mockUpsert(...args),
  deleteByKey: (...args) => mockDeleteByKey(...args),
}));

const mockInvalidate = jest.fn();
const mockResolveEffective = jest.fn();

jest.mock('../intelligenceConfig.resolver', () => ({
  invalidate: (...args) => mockInvalidate(...args),
  resolveEffective: (...args) => mockResolveEffective(...args),
}));

const mockLogAdminAction = jest.fn().mockResolvedValue(undefined);

jest.mock('../../../utils/adminAuditLogger', () => ({
  logAdminAction: (...args) => mockLogAdminAction(...args),
}));

const service = require('../intelligenceConfig.service');

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveEffective.mockResolvedValue({ value: 'gemini,grok,mistral,openai,anthropic', source: 'default' });
});

describe('intelligenceConfig.service — getSetting / listSettings', () => {
  it('rejects an unknown key without touching the repository', async () => {
    await expect(service.getSetting('BOGUS')).rejects.toMatchObject({
      status: 400,
      code: 'UNKNOWN_CONFIG_KEY',
    });
    expect(mockResolveEffective).not.toHaveBeenCalled();
  });

  it('returns the effective value + source for a known key', async () => {
    mockResolveEffective.mockResolvedValue({ value: 'gemini,openai', source: 'environment' });
    const result = await service.getSetting('AI_PROVIDER_PRIORITY');
    expect(result.key).toBe('AI_PROVIDER_PRIORITY');
    expect(result.value).toBe('gemini,openai');
    expect(result.source).toBe('environment');
    expect(result.adminConfigured).toBe(false);
  });

  it('marks adminConfigured true only when source is admin', async () => {
    mockResolveEffective.mockResolvedValue({ value: 'gemini', source: 'admin' });
    const result = await service.getSetting('AI_PROVIDER_PRIORITY');
    expect(result.adminConfigured).toBe(true);
  });

  it('listSettings returns one entry per supported key', async () => {
    const result = await service.listSettings();
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('AI_PROVIDER_PRIORITY');
  });

  it('never includes a secret-shaped field (value/preview of a credential) in the response', async () => {
    const result = await service.getSetting('AI_PROVIDER_PRIORITY');
    expect(result).not.toHaveProperty('apiKey');
    expect(result).not.toHaveProperty('secretName');
    expect(result).not.toHaveProperty('preview');
  });
});

describe('intelligenceConfig.service — updateSetting', () => {
  it('rejects an unknown key without touching the repository', async () => {
    await expect(service.updateSetting('BOGUS', 'gemini', 'admin-1')).rejects.toMatchObject({
      status: 400,
      code: 'UNKNOWN_CONFIG_KEY',
    });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('rejects an empty value without touching the repository', async () => {
    await expect(service.updateSetting('AI_PROVIDER_PRIORITY', '', 'admin-1')).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_INPUT',
    });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('rejects an invalid provider list without touching the repository', async () => {
    await expect(
      service.updateSetting('AI_PROVIDER_PRIORITY', 'gemini,not-a-provider', 'admin-1')
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_CONFIG_VALUE' });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('persists the normalized value, write-through invalidates the cache, and audits the change', async () => {
    mockFindByKey.mockResolvedValue(null); // no previous override
    mockUpsert.mockResolvedValue({
      key: 'AI_PROVIDER_PRIORITY',
      value: 'gemini,openai',
      updatedBy: 'admin-1',
      updatedAt: '2026-08-22T00:00:00.000Z',
    });

    const result = await service.updateSetting('AI_PROVIDER_PRIORITY', ' Gemini , OpenAI ', 'admin-1');

    expect(mockUpsert).toHaveBeenCalledWith('AI_PROVIDER_PRIORITY', 'gemini,openai', 'admin-1');
    expect(mockInvalidate).toHaveBeenCalledWith('AI_PROVIDER_PRIORITY', 'gemini,openai');
    expect(result.value).toBe('gemini,openai');
    expect(result.source).toBe('admin');

    expect(mockLogAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        adminId: 'admin-1',
        action: 'INTELLIGENCE_CONFIG_UPDATE',
        entityType: 'intelligence_config',
        entityId: 'AI_PROVIDER_PRIORITY',
        metadata: expect.objectContaining({
          key: 'AI_PROVIDER_PRIORITY',
          previousValue: null,
          newValue: 'gemini,openai',
        }),
      })
    );
  });

  it('records the previous value in the audit metadata when one existed', async () => {
    mockFindByKey.mockResolvedValue({ key: 'AI_PROVIDER_PRIORITY', value: 'mistral' });
    mockUpsert.mockResolvedValue({ key: 'AI_PROVIDER_PRIORITY', value: 'gemini' });

    await service.updateSetting('AI_PROVIDER_PRIORITY', 'gemini', 'admin-1');

    expect(mockLogAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ previousValue: 'mistral', newValue: 'gemini' }),
      })
    );
  });
});

describe('intelligenceConfig.service — resetSetting', () => {
  it('rejects an unknown key without touching the repository', async () => {
    await expect(service.resetSetting('BOGUS', 'admin-1')).rejects.toMatchObject({
      status: 400,
      code: 'UNKNOWN_CONFIG_KEY',
    });
    expect(mockDeleteByKey).not.toHaveBeenCalled();
  });

  it('deletes the override, invalidates the cache (drop, not write-through), and audits the reset', async () => {
    mockFindByKey.mockResolvedValue({ key: 'AI_PROVIDER_PRIORITY', value: 'mistral' });
    mockDeleteByKey.mockResolvedValue(true);
    mockResolveEffective.mockResolvedValue({ value: 'gemini,grok,mistral,openai,anthropic', source: 'default' });

    const result = await service.resetSetting('AI_PROVIDER_PRIORITY', 'admin-1');

    expect(mockDeleteByKey).toHaveBeenCalledWith('AI_PROVIDER_PRIORITY');
    expect(mockInvalidate).toHaveBeenCalledWith('AI_PROVIDER_PRIORITY');
    expect(mockInvalidate).not.toHaveBeenCalledWith('AI_PROVIDER_PRIORITY', expect.anything());
    expect(result.source).toBe('default');

    expect(mockLogAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'INTELLIGENCE_CONFIG_RESET',
        entityId: 'AI_PROVIDER_PRIORITY',
        metadata: expect.objectContaining({ previousValue: 'mistral', wasSet: true }),
      })
    );
  });

  it('is a safe no-op (still 200-shaped) when no override was set', async () => {
    mockFindByKey.mockResolvedValue(null);
    mockDeleteByKey.mockResolvedValue(false);

    const result = await service.resetSetting('AI_PROVIDER_PRIORITY', 'admin-1');

    expect(result.source).toBe('default');
    expect(mockLogAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ previousValue: null, wasSet: false }),
      })
    );
  });
});
