'use strict';

const { DecisionTypeRegistry, decisionTypeRegistry } = require('../decisionTypeRegistry');

describe('decisionTypeRegistry', () => {
  it('exports a shared instance pre-registered with the v1 baseline (skill, career)', () => {
    expect(decisionTypeRegistry.isImplemented('skill')).toBe(true);
    expect(decisionTypeRegistry.isImplemented('career')).toBe(true);
    expect(decisionTypeRegistry.list().slice().sort()).toEqual(['career', 'skill']);
  });

  it('does not treat any other known decisionType as implemented', () => {
    const others = ['programme', 'course', 'scholarship', 'institution', 'futureSkill', 'occupation'];
    for (const type of others) {
      expect(decisionTypeRegistry.isImplemented(type)).toBe(false);
    }
  });

  it('list() returns a frozen snapshot that cannot mutate the internal set', () => {
    const snapshot = decisionTypeRegistry.list();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => snapshot.push('programme')).toThrow();
    expect(decisionTypeRegistry.isImplemented('programme')).toBe(false);
  });

  describe('a fresh instance', () => {
    it('starts empty by default', () => {
      const registry = new DecisionTypeRegistry();
      expect(registry.list()).toEqual([]);
      expect(registry.isImplemented('skill')).toBe(false);
    });

    it('accepts initial types via the constructor', () => {
      const registry = new DecisionTypeRegistry(['skill']);
      expect(registry.isImplemented('skill')).toBe(true);
      expect(registry.isImplemented('career')).toBe(false);
    });

    it('register() adds a type and is idempotent', () => {
      const registry = new DecisionTypeRegistry(['skill']);
      registry.register('career');
      registry.register('career');
      expect(registry.list().slice().sort()).toEqual(['career', 'skill']);
    });

    it('register() trims whitespace and rejects non-string/empty input', () => {
      const registry = new DecisionTypeRegistry();
      registry.register('  programme  ');
      expect(registry.isImplemented('programme')).toBe(true);

      expect(() => registry.register('')).toThrow();
      expect(() => registry.register('   ')).toThrow();
      expect(() => registry.register(null)).toThrow();
      expect(() => registry.register(undefined)).toThrow();
      expect(() => registry.register(42)).toThrow();
    });

    it('register() returns `this` for chaining', () => {
      const registry = new DecisionTypeRegistry();
      const result = registry.register('skill').register('career');
      expect(result).toBe(registry);
      expect(registry.list().slice().sort()).toEqual(['career', 'skill']);
    });
  });
});
