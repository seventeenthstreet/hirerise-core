'use strict';

/**
 * intelligenceProviders.definitions.test.js — WP-ADMIN-INTEL-06
 *
 * Unit tests for the "Add Provider" validation/definitions layer. No
 * Supabase/network dependency — aiProviderManager.PROVIDER_REGISTRY is a
 * plain in-memory object.
 */

const definitions = require('../intelligenceProviders.definitions');
const { PROVIDER_REGISTRY } = require('../../../services/ai/aiProviderManager');

describe('intelligenceProviders.definitions — registries', () => {
  it('BUILTIN_PROVIDER_KEYS mirrors aiProviderManager.PROVIDER_REGISTRY exactly', () => {
    expect(definitions.BUILTIN_PROVIDER_KEYS.slice().sort()).toEqual(
      Object.keys(PROVIDER_REGISTRY).sort()
    );
  });

  it('KNOWN_ADAPTER_TYPES matches the migration allowlist', () => {
    expect(definitions.KNOWN_ADAPTER_TYPES.slice().sort()).toEqual(
      ['anthropic', 'gemini', 'grok', 'mistral', 'openai'].sort()
    );
  });
});

describe('intelligenceProviders.definitions — validateProviderKey', () => {
  it('accepts a well-formed new key', () => {
    const result = definitions.validateProviderKey('cohere');
    expect(result).toEqual({ valid: true, normalized: 'cohere' });
  });

  it('lowercases and trims', () => {
    const result = definitions.validateProviderKey('  Cohere  ');
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe('cohere');
  });

  it('rejects a key colliding with a built-in provider', () => {
    for (const key of definitions.BUILTIN_PROVIDER_KEYS) {
      const result = definitions.validateProviderKey(key);
      expect(result.valid).toBe(false);
      expect(result.code).toBe('BUILTIN_PROVIDER_KEY');
    }
  });

  it('rejects malformed keys', () => {
    expect(definitions.validateProviderKey('').valid).toBe(false);
    expect(definitions.validateProviderKey('1cohere').valid).toBe(false); // must start with a letter
    expect(definitions.validateProviderKey('Co here').valid).toBe(false); // no spaces
    expect(definitions.validateProviderKey('a').valid).toBe(false); // too short
    expect(definitions.validateProviderKey('co-here').valid).toBe(false); // no hyphens
    expect(definitions.validateProviderKey('a'.repeat(41)).valid).toBe(false); // too long
  });
});

describe('intelligenceProviders.definitions — validateEndpoint', () => {
  it('accepts a valid https URL', () => {
    expect(definitions.validateEndpoint('https://api.cohere.ai/v1/chat')).toEqual({
      valid: true,
      normalized: 'https://api.cohere.ai/v1/chat',
    });
  });

  it('treats empty/omitted as valid null (optional field)', () => {
    expect(definitions.validateEndpoint(undefined)).toEqual({ valid: true, normalized: null });
    expect(definitions.validateEndpoint(null)).toEqual({ valid: true, normalized: null });
    expect(definitions.validateEndpoint('')).toEqual({ valid: true, normalized: null });
  });

  it('rejects non-https URLs', () => {
    expect(definitions.validateEndpoint('http://api.cohere.ai').valid).toBe(false);
  });

  it('rejects malformed URLs', () => {
    expect(definitions.validateEndpoint('not a url').valid).toBe(false);
  });

  it('rejects a request to dynamically execute an arbitrary non-URL string', () => {
    expect(definitions.validateEndpoint('javascript:alert(1)').valid).toBe(false);
  });
});

describe('intelligenceProviders.definitions — validateProviderInput (create)', () => {
  it('requires providerKey, displayName, and adapterType', () => {
    const { valid, errors } = definitions.validateProviderInput({});
    expect(valid).toBe(false);
    expect(errors.providerKey).toBeDefined();
    expect(errors.displayName).toBeDefined();
    expect(errors.adapterType).toBeDefined();
  });

  it('accepts a full valid payload and normalizes it', () => {
    const { valid, normalized } = definitions.validateProviderInput({
      providerKey: 'Cohere',
      displayName: '  Cohere  ',
      adapterType: 'OPENAI',
      apiEndpoint: 'https://api.cohere.ai/v1/chat',
      defaultModel: 'command-r',
    });
    expect(valid).toBe(true);
    expect(normalized).toEqual({
      providerKey: 'cohere',
      displayName: 'Cohere',
      adapterType: 'openai',
      apiEndpoint: 'https://api.cohere.ai/v1/chat',
      defaultModel: 'command-r',
    });
  });

  it('rejects an unsupported adapter type', () => {
    const { valid, errors } = definitions.validateProviderInput({
      providerKey: 'cohere',
      displayName: 'Cohere',
      adapterType: 'some-made-up-protocol',
    });
    expect(valid).toBe(false);
    expect(errors.adapterType).toMatch(/Unsupported adapter/);
  });

  it('ignores unknown fields rather than persisting them', () => {
    const { valid, normalized } = definitions.validateProviderInput({
      providerKey: 'cohere',
      displayName: 'Cohere',
      adapterType: 'openai',
      apiKeyThatShouldNeverBeHere: 'sk-should-not-be-normalized',
    });
    expect(valid).toBe(true);
    expect(normalized.apiKeyThatShouldNeverBeHere).toBeUndefined();
  });
});

describe('intelligenceProviders.definitions — validateProviderInput (partial/update)', () => {
  it('only validates fields actually present', () => {
    const { valid, normalized, errors } = definitions.validateProviderInput(
      { enabled: false },
      { partial: true }
    );
    expect(valid).toBe(true);
    expect(normalized).toEqual({ enabled: false });
    expect(errors).toEqual({});
  });

  it('still rejects a present-but-invalid field', () => {
    const { valid, errors } = definitions.validateProviderInput(
      { apiEndpoint: 'ftp://not-https' },
      { partial: true }
    );
    expect(valid).toBe(false);
    expect(errors.apiEndpoint).toBeDefined();
  });
});
