'use strict';

/**
 * @file src/domain/profileReadiness/__tests__/capabilityRegistry.test.js
 *
 * WP-SPCE-02A — unit tests for capabilityRegistry.js, plus the registry
 * self-validation required by WP-SPCE-01D §4/§10 ("every requiredFields
 * entry must resolve against professionalProfile.schema.js", "no duplicate
 * capability ids", "no malformed definitions").
 */

const {
  CAPABILITY_IDS,
  CAPABILITIES,
  getCapability,
  listCapabilityIds,
  validateRegistry,
} = require('../capabilityRegistry');

describe('capabilityRegistry — registry self-validation', () => {
  it('passes validateRegistry() with zero errors for the shipped registry', () => {
    const result = validateRegistry();
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('every CAPABILITY_IDS value has a corresponding CAPABILITIES entry', () => {
    for (const id of Object.values(CAPABILITY_IDS)) {
      expect(CAPABILITIES[id]).toBeDefined();
      expect(CAPABILITIES[id].id).toBe(id);
    }
  });

  it('detects a required field path that does not resolve against the schema', () => {
    const result = validateRegistry({
      some_capability: {
        id: 'some_capability',
        description: 'test',
        addedIn: 'test',
        requiredFields: ['thisFieldDoesNotExist.anywhere'],
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('thisFieldDoesNotExist.anywhere')])
    );
  });

  it('detects a required field path that traverses through a non-object leaf', () => {
    // 'personalInformation.fullName.nested' — fullName resolves to a
    // string leaf in the schema shape, so trying to go one level deeper
    // must fail the structural resolution check.
    const result = validateRegistry({
      some_capability: {
        id: 'some_capability',
        description: 'test',
        addedIn: 'test',
        requiredFields: ['personalInformation.fullName.nested'],
      },
    });
    expect(result.valid).toBe(false);
  });

  it('every declared field path for every capability resolves against the canonical schema', () => {
    const { emptyProfessionalProfile } = require(
      '../../professionalProfile/professionalProfile.schema'
    );
    const shape = emptyProfessionalProfile(null);

    function collectLeaves(expr) {
      if (typeof expr === 'string') return [expr];
      if (expr && Array.isArray(expr.all)) return expr.all.flatMap(collectLeaves);
      if (expr && Array.isArray(expr.any)) return expr.any.flatMap(collectLeaves);
      return [];
    }

    const { toExpression } = require('../capabilityRegistry');

    for (const [key, definition] of Object.entries(CAPABILITIES)) {
      const leaves = collectLeaves(toExpression(definition));
      expect(leaves.length).toBeGreaterThan(0);
      for (const fieldPath of leaves) {
        let cursor = shape;
        for (const segment of fieldPath.split('.')) {
          expect(cursor).not.toBeNull();
          expect(typeof cursor).toBe('object');
          expect(segment in cursor).toBe(true);
          cursor = cursor[segment];
        }
      }
      // sanity check this loop actually ran for every registry key
      expect(key).toBe(definition.id);
    }
  });

  it('rejects a definition whose id does not match its registry key', () => {
    const result = validateRegistry({
      wrong_key: { id: 'right_key', description: 'x', addedIn: 'x', requiredFields: ['skills'] },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('mismatched id')])
    );
  });

  it('rejects a definition entirely missing its id field', () => {
    const result = validateRegistry({
      some_key: { description: 'x', addedIn: 'x', requiredFields: ['skills'] },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('missing a valid "id" field')])
    );
  });

  it('rejects a definition entirely missing its description field', () => {
    const result = validateRegistry({
      some_key: { id: 'some_key', addedIn: 'x', requiredFields: ['skills'] },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('missing a valid "description" field')])
    );
  });

  it('rejects a definition entirely missing its addedIn field', () => {
    const result = validateRegistry({
      some_key: { id: 'some_key', description: 'x', requiredFields: ['skills'] },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('missing a valid "addedIn" field')])
    );
  });

  it('rejects a definition with a non-array requiredFields', () => {
    const result = validateRegistry({
      some_key: { id: 'some_key', description: 'x', addedIn: 'x', requiredFields: 'skills' },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('non-empty "requiredFields" array')])
    );
  });

  it('rejects a definition with an empty requiredFields array', () => {
    const result = validateRegistry({
      some_key: { id: 'some_key', description: 'x', addedIn: 'x', requiredFields: [] },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('non-empty "requiredFields" array')])
    );
  });

  it('rejects a requiredFields entry that is not a non-empty string', () => {
    const result = validateRegistry({
      some_key: { id: 'some_key', description: 'x', addedIn: 'x', requiredFields: [42, ''] },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('non-string/empty field path')])
    );
  });

  it('rejects a definition that is not an object at all', () => {
    const result = validateRegistry({ some_key: null });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('not a valid definition object')])
    );
  });

  it('rejects a registry with a genuine duplicate id across two distinct keys', () => {
    const result = validateRegistry({
      key_one: { id: 'shared_id', description: 'x', addedIn: 'x', requiredFields: ['skills'] },
      key_two: { id: 'shared_id', description: 'y', addedIn: 'y', requiredFields: ['experience'] },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('Duplicate capability id detected: "shared_id"')])
    );
  });

  it('a single well-formed entry whose id matches its key passes with no errors', () => {
    const result = validateRegistry({
      shared_id: { id: 'shared_id', description: 'x', addedIn: 'x', requiredFields: ['skills'] },
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('CAPABILITIES is frozen and cannot be mutated', () => {
    expect(Object.isFrozen(CAPABILITIES)).toBe(true);
    expect(() => {
      CAPABILITIES.new_capability = { id: 'new_capability' };
    }).toThrow();
  });

  it('each individual capability definition is frozen', () => {
    for (const definition of Object.values(CAPABILITIES)) {
      expect(Object.isFrozen(definition)).toBe(true);
      if (definition.requiredFields !== undefined) {
        expect(Object.isFrozen(definition.requiredFields)).toBe(true);
      } else {
        expect(Object.isFrozen(definition.requires)).toBe(true);
      }
    }
  });

  it('exactly one of requiredFields/requires is present on every shipped definition (never both, never neither)', () => {
    for (const definition of Object.values(CAPABILITIES)) {
      const hasRequiredFields = definition.requiredFields !== undefined;
      const hasRequires = definition.requires !== undefined;
      expect(hasRequiredFields).not.toBe(hasRequires);
    }
  });
});

describe('capabilityRegistry — expression-tree validation (WP-SPCE-02B)', () => {
  it('accepts a single leaf string as a valid requires expression', () => {
    const result = validateRegistry({
      cap: { id: 'cap', description: 'x', addedIn: 'x', requires: 'skills' },
    });
    expect(result.valid).toBe(true);
  });

  it('accepts a simple AND group', () => {
    const result = validateRegistry({
      cap: { id: 'cap', description: 'x', addedIn: 'x', requires: { all: ['skills', 'experience'] } },
    });
    expect(result.valid).toBe(true);
  });

  it('accepts a simple OR group', () => {
    const result = validateRegistry({
      cap: { id: 'cap', description: 'x', addedIn: 'x', requires: { any: ['skills', 'experience'] } },
    });
    expect(result.valid).toBe(true);
  });

  it('accepts nested groups (OR inside AND)', () => {
    const result = validateRegistry({
      cap: {
        id: 'cap', description: 'x', addedIn: 'x',
        requires: { all: [{ any: ['education', 'experience'] }, 'careerGoals.expectedRoleIds'] },
      },
    });
    expect(result.valid).toBe(true);
  });

  it('accepts nested groups (AND inside OR)', () => {
    const result = validateRegistry({
      cap: {
        id: 'cap', description: 'x', addedIn: 'x',
        requires: { any: [{ all: ['education', 'skills'] }, 'experience'] },
      },
    });
    expect(result.valid).toBe(true);
  });

  it('accepts deep nesting (4+ levels)', () => {
    const result = validateRegistry({
      cap: {
        id: 'cap', description: 'x', addedIn: 'x',
        requires: {
          all: [
            { any: [
              { all: [
                { any: ['skills', 'experience'] },
                'education',
              ] },
              'careerGoals.targetRole',
            ] },
            'personalInformation.fullName',
          ],
        },
      },
    });
    expect(result.valid).toBe(true);
  });

  it('rejects a field path that does not resolve, even deep inside a nested expression', () => {
    const result = validateRegistry({
      cap: {
        id: 'cap', description: 'x', addedIn: 'x',
        requires: { all: [{ any: ['skills', 'thisDoesNotExist'] }, 'experience'] },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('thisDoesNotExist')])
    );
  });

  it('rejects an unknown operator', () => {
    const result = validateRegistry({
      cap: { id: 'cap', description: 'x', addedIn: 'x', requires: { xor: ['skills', 'experience'] } },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('unknown operator')])
    );
  });

  it('rejects a node mixing "all" and "any" together', () => {
    const result = validateRegistry({
      cap: { id: 'cap', description: 'x', addedIn: 'x', requires: { all: ['skills'], any: ['experience'] } },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('must not mix "all" and "any"')])
    );
  });

  it('rejects an empty AND group', () => {
    const result = validateRegistry({
      cap: { id: 'cap', description: 'x', addedIn: 'x', requires: { all: [] } },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('non-empty array')])
    );
  });

  it('rejects an empty OR group', () => {
    const result = validateRegistry({
      cap: { id: 'cap', description: 'x', addedIn: 'x', requires: { any: [] } },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('non-empty array')])
    );
  });

  it('rejects a group whose children are not an array', () => {
    const result = validateRegistry({
      cap: { id: 'cap', description: 'x', addedIn: 'x', requires: { all: 'skills' } },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('non-empty array')])
    );
  });

  it('rejects a malformed node that is neither a string nor a valid group object', () => {
    const result = validateRegistry({
      cap: { id: 'cap', description: 'x', addedIn: 'x', requires: { all: [42, 'skills'] } },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('malformed expression node')])
    );
  });

  it('rejects an expression object with no operator at all', () => {
    const result = validateRegistry({
      cap: { id: 'cap', description: 'x', addedIn: 'x', requires: {} },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('must declare "all" or "any"')])
    );
  });

  it('rejects a null requires value', () => {
    const result = validateRegistry({
      cap: { id: 'cap', description: 'x', addedIn: 'x', requires: null },
    });
    expect(result.valid).toBe(false);
  });

  it('rejects an empty-string leaf inside an expression tree', () => {
    const result = validateRegistry({
      cap: { id: 'cap', description: 'x', addedIn: 'x', requires: { all: [''] } },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('empty field path')])
    );
  });

  it('rejects a definition declaring both requiredFields and requires', () => {
    const result = validateRegistry({
      cap: {
        id: 'cap', description: 'x', addedIn: 'x',
        requiredFields: ['skills'],
        requires: 'experience',
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('declares both')])
    );
  });

  it('rejects a definition declaring neither requiredFields nor requires', () => {
    const result = validateRegistry({
      cap: { id: 'cap', description: 'x', addedIn: 'x' },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('declares neither')])
    );
  });
});

describe('capabilityRegistry — toExpression() / getCapabilityExpression() (WP-SPCE-02B)', () => {
  const { toExpression, getCapabilityExpression } = require('../capabilityRegistry');

  it('normalizes a legacy requiredFields definition into an implicit AND group', () => {
    const definition = { id: 'x', description: 'x', addedIn: 'x', requiredFields: ['a', 'b'] };
    expect(toExpression(definition)).toEqual({ all: ['a', 'b'] });
  });

  it('passes through a requires expression unchanged', () => {
    const expr = { any: ['a', 'b'] };
    const definition = { id: 'x', description: 'x', addedIn: 'x', requires: expr };
    expect(toExpression(definition)).toBe(expr);
  });

  it('getCapabilityExpression() resolves a real shipped capability end-to-end', () => {
    expect(getCapabilityExpression('chi_score')).toEqual({ all: ['skills', 'experience'] });
    expect(getCapabilityExpression('career_report')).toEqual({
      all: [{ any: ['education', 'experience'] }, 'careerGoals.expectedRoleIds'],
    });
  });

  it('getCapabilityExpression() throws for an unknown capability, same as getCapability()', () => {
    expect(() => getCapabilityExpression('not_real')).toThrow(/Unknown capability id/);
  });
});

describe('capabilityRegistry — getCapability()', () => {
  it('returns the definition for a known capability id', () => {
    const definition = getCapability(CAPABILITY_IDS.CHI_SCORE);
    expect(definition.id).toBe('chi_score');
    expect(definition.requiredFields).toEqual(
      expect.arrayContaining(['skills', 'experience'])
    );
  });

  it('throws for an unknown capability id', () => {
    expect(() => getCapability('not_a_real_capability')).toThrow(
      /Unknown capability id/
    );
  });

  it('throws for an empty string capability id', () => {
    expect(() => getCapability('')).toThrow(/Unknown capability id/);
  });

  it('throws for a null/undefined capability id', () => {
    expect(() => getCapability(null)).toThrow(/Unknown capability id/);
    expect(() => getCapability(undefined)).toThrow(/Unknown capability id/);
  });
});

describe('capabilityRegistry — listCapabilityIds()', () => {
  it('returns every registered capability id', () => {
    const ids = listCapabilityIds();
    expect(ids).toEqual(
      expect.arrayContaining([
        'professional_onboarding_completion',
        'career_report',
        'resume_generator',
        'job_matching',
        'chi_score',
      ])
    );
    expect(ids).toHaveLength(5);
  });

  it('returns only strings', () => {
    for (const id of listCapabilityIds()) {
      expect(typeof id).toBe('string');
    }
  });
});
