'use strict';

/**
 * @file core-work/src/modules/snapshot-intelligence/__tests__/snapshot.serialization.test.js
 * KR-02A — Snapshot Domain Foundation — Serialization tests
 */

const { buildValidSnapshot } = require('../testHelpers/snapshot.fixtures');
const {
  toSnapshotDTO,
  toSnapshotListItemReadModel,
  toSnapshotComparisonReadModel,
} = require('../domain/dto/snapshot.dto');
const {
  EVENT_TYPES,
  buildSnapshotCreatedPayload,
  buildSnapshotSupersededPayload,
  buildRecalculationCompletedPayload,
} = require('../domain/events/snapshot.eventContracts');

describe('toSnapshotDTO', () => {
  it('produces a plain, JSON-serializable object', () => {
    const snapshot = buildValidSnapshot();
    const dto = toSnapshotDTO(snapshot);
    expect(() => JSON.stringify(dto)).not.toThrow();
    expect(dto.id).toBe(snapshot.id);
    expect(dto.version).toBe(1);
    expect(dto.context.evidenceCount).toBe(1);
  });

  it('round-trips through JSON without losing scalar fields', () => {
    const snapshot = buildValidSnapshot();
    const dto = toSnapshotDTO(snapshot);
    const roundTripped = JSON.parse(JSON.stringify(dto));
    expect(roundTripped).toEqual(dto);
  });
});

describe('toSnapshotListItemReadModel', () => {
  it('produces a minimal shape without context detail', () => {
    const snapshot = buildValidSnapshot();
    const readModel = toSnapshotListItemReadModel(snapshot);
    expect(readModel).not.toHaveProperty('context');
    expect(readModel.id).toBe(snapshot.id);
  });
});

describe('toSnapshotComparisonReadModel', () => {
  it('pairs two snapshot DTOs', () => {
    const a = buildValidSnapshot({ id: 'snapshot-a' });
    const b = buildValidSnapshot({ id: 'snapshot-b' });
    const comparison = toSnapshotComparisonReadModel(a, b);
    expect(comparison.from.id).toBe('snapshot-a');
    expect(comparison.to.id).toBe('snapshot-b');
  });
});

describe('event payload contracts', () => {
  it('builds a snapshot-created payload tagged with the correct eventType', () => {
    const snapshot = buildValidSnapshot();
    const payload = buildSnapshotCreatedPayload(snapshot);
    expect(payload.eventType).toBe(EVENT_TYPES.SNAPSHOT_CREATED);
    expect(payload.snapshotId).toBe(snapshot.id);
    expect(() => JSON.stringify(payload)).not.toThrow();
  });

  it('builds a snapshot-superseded payload referencing both snapshots', () => {
    const superseded = buildValidSnapshot({ id: 'snapshot-old' });
    const replacement = buildValidSnapshot({ id: 'snapshot-new' });
    const payload = buildSnapshotSupersededPayload(superseded, replacement);
    expect(payload.eventType).toBe(EVENT_TYPES.SNAPSHOT_SUPERSEDED);
    expect(payload.snapshotId).toBe('snapshot-old');
    expect(payload.supersededBySnapshotId).toBe('snapshot-new');
  });

  it('builds a recalculation-completed payload from plain params', () => {
    const payload = buildRecalculationCompletedPayload({
      subject: { subjectType: 'STUDENT', subjectId: 's-1' },
      scope: 'resume',
      triggerId: 'trigger-9',
      resultingSnapshotId: 'snapshot-9',
    });
    expect(payload.eventType).toBe(EVENT_TYPES.RECALCULATION_COMPLETED);
    expect(payload.resultingSnapshotId).toBe('snapshot-9');
  });
});
