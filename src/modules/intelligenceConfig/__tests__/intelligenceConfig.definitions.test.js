'use strict';

/**
 * intelligenceConfig.definitions.test.js — WP-ADMIN-INTEL-04
 *
 * Verifies:
 *   - only AI_PROVIDER_PRIORITY is exposed as a supported key
 *   - unknown keys are rejected
 *   - valid provider lists are accepted and normalized
 *   - unknown provider names are rejected
 *   - duplicate provider names are rejected
 *   - empty values are rejected
 *   - codeDefault is sourced from aiProviderManager.DEFAULT_PRIORITY, not
 *     redeclared here
 */

const definitions = require('../intelligenceConfig.definitions');
const { PROVIDER_REGISTRY, DEFAULT_PRIORITY } = require('../../../services/ai/aiProviderManager');

describe('intelligenceConfig.definitions — registry surface', () => {
  it('exposes exactly AI_PROVIDER_PRIORITY as a supported key', () => {
    expect(definitions.listKeys()).toEqual(['AI_PROVIDER_PRIORITY']);
  });

  it('isSupportedKey returns true only for AI_PROVIDER_PRIORITY', () => {
    expect(definitions.isSupportedKey('AI_PROVIDER_PRIORITY')).toBe(true);
    expect(definitions.isSupportedKey('AI_PROVIDER_TIMEOUT_MS')).toBe(false);
    expect(definitions.isSupportedKey('ANTHROPIC_API_KEY')).toBe(false);
    expect(definitions.isSupportedKey('')).toBe(false);
    expect(definitions.isSupportedKey(undefined)).toBe(false);
  });

  it('assertSupportedKey throws a safe 400 for an unknown key', () => {
    expect(() => definitions.assertSupportedKey('BOGUS')).toThrow(
      "Unsupported Intelligence configuration key: 'BOGUS'."
    );
    try {
      definitions.assertSupportedKey('BOGUS');
    } catch (err) {
      expect(err.status).toBe(400);
      expect(err.code).toBe('UNKNOWN_CONFIG_KEY');
    }
  });

  it('assertSupportedKey returns the definition for a known key', () => {
    const def = definitions.assertSupportedKey('AI_PROVIDER_PRIORITY');
    expect(def.key).toBe('AI_PROVIDER_PRIORITY');
  });

  it('sources codeDefault from aiProviderManager.DEFAULT_PRIORITY (not redeclared)', () => {
    const def = definitions.getDefinition('AI_PROVIDER_PRIORITY');
    expect(def.codeDefault).toBe(DEFAULT_PRIORITY);
  });

  it('sources allowedValues from aiProviderManager.PROVIDER_REGISTRY (not redeclared)', () => {
    const def = definitions.getDefinition('AI_PROVIDER_PRIORITY');
    expect(def.allowedValues).toEqual(Object.keys(PROVIDER_REGISTRY));
  });
});

describe('intelligenceConfig.definitions — AI_PROVIDER_PRIORITY validation', () => {
  const def = definitions.getDefinition('AI_PROVIDER_PRIORITY');

  it('accepts a valid, known provider list', () => {
    const result = def.validate('gemini,openai,anthropic');
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe('gemini,openai,anthropic');
  });

  it('normalizes case and whitespace', () => {
    const result = def.validate(' Gemini , OPENAI ,anthropic ');
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe('gemini,openai,anthropic');
  });

  it('rejects an empty string', () => {
    expect(def.validate('').valid).toBe(false);
  });

  it('rejects a whitespace-only string', () => {
    expect(def.validate('   ').valid).toBe(false);
  });

  it('rejects a non-string value', () => {
    expect(def.validate(null).valid).toBe(false);
    expect(def.validate(undefined).valid).toBe(false);
    expect(def.validate(42).valid).toBe(false);
  });

  it('rejects an unknown provider name', () => {
    const result = def.validate('gemini,bogus-provider');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Unknown provider/);
    expect(result.error).toMatch(/bogus-provider/);
  });

  it('rejects a duplicate provider name', () => {
    const result = def.validate('gemini,openai,gemini');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Duplicate provider/);
  });

  it('accepts every known provider individually', () => {
    for (const provider of Object.keys(PROVIDER_REGISTRY)) {
      const result = def.validate(provider);
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe(provider);
    }
  });
});
