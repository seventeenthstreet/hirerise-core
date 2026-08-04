'use strict';

/**
 * @file core-work/src/modules/snapshot-intelligence/__tests__/snapshot.immutability.test.js
 * KR-02A — Snapshot Domain Foundation — Immutability tests
 *
 * Verifies KR-01B's "snapshots are immutable / moments are immutable /
 * context is immutable / historical records are append-only" principle
 * is enforced at the domain layer, not just by convention.
 */

const { buildValidSnapshot } = require('../testHelpers/snapshot.fixtures');

describe('Snapshot immutability', () => {
  it('is frozen at the top level', () => {
    const snapshot = buildValidSnapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('throws when attempting to mutate a top-level field', () => {
    'use strict';

    const snapshot = buildValidSnapshot();
    expect(() => {
      snapshot.lifecycle = 'SUPERSEDED';
    }).toThrow(TypeError);
  });

  it('is deeply frozen — nested moment and context objects are also frozen', () => {
    const snapshot = buildValidSnapshot();
    expect(Object.isFrozen(snapshot.moment)).toBe(true);
    expect(Object.isFrozen(snapshot.moment.timestamp)).toBe(true);
    expect(Object.isFrozen(snapshot.context)).toBe(true);
    expect(Object.isFrozen(snapshot.context.evidence)).toBe(true);
    expect(Object.isFrozen(snapshot.context.evidence.evidence[0])).toBe(true);
    expect(Object.isFrozen(snapshot.metadata)).toBe(true);
  });

  it('throws when attempting to mutate a nested moment field', () => {
    'use strict';

    const snapshot = buildValidSnapshot();
    expect(() => {
      snapshot.moment.momentType = 'something-else';
    }).toThrow(TypeError);
  });

  it('throws when attempting to push into a frozen array field', () => {
    'use strict';

    const snapshot = buildValidSnapshot();
    expect(() => {
      snapshot.context.evidence.evidence.push({});
    }).toThrow(TypeError);
  });

  it('represents a changed subject state as a new Snapshot rather than a mutation', () => {
    const first = buildValidSnapshot();
    const second = buildValidSnapshot({
      id: 'snapshot-124',
      version: { version: 2, supersedes: first.id },
    });
    expect(first.id).not.toBe(second.id);
    expect(second.version.supersedes).toBe(first.id);
    // The original is untouched.
    expect(first.lifecycle).toBe('ACTIVE');
  });
});
