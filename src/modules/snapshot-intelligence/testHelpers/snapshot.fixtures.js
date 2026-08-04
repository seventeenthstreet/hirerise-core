'use strict';

/**
 * @file core-work/src/modules/snapshot-intelligence/testHelpers/snapshot.fixtures.js
 * KR-02A — Snapshot Domain Foundation — shared test fixtures.
 *
 * Builds one fully valid Snapshot entity via the real entity factories
 * (not a hand-built plain object), so every test that imports this
 * fixture is implicitly re-exercising the entity construction path.
 */

const {
  createSnapshotIdentifier,
  createMomentIdentifier,
  createSubjectReference,
  createSnapshotVersion,
  createSnapshotState,
  createSnapshotMetadata,
  createSnapshotEvidenceReference,
  createMoment,
  createContextEnvelope,
  createSnapshot,
} = require('../domain/entities/snapshot.entities');

const {
  createSnapshotTimestamp,
  createSnapshotReason,
  createSnapshotSource,
  createSnapshotConfidence,
  createSnapshotTrigger,
  createContextScope,
  createEvidenceReference,
  createSignalReference,
} = require('../domain/value-objects/snapshot.valueObjects');

function buildValidSnapshot(overrides = {}) {
  const subject = createSubjectReference({ subjectType: 'STUDENT', subjectId: 'student-123' });
  const momentId = createMomentIdentifier('moment-123');

  const moment = createMoment({
    id: momentId,
    subject,
    momentType: 'resume-updated',
    momentCategory: 'resume',
    classification: 'MILESTONE',
    timestamp: createSnapshotTimestamp({ occurredAt: '2026-01-01T00:00:00.000Z' }),
    reason: createSnapshotReason({ code: 'RESUME_REPARSED' }),
  });

  const context = createContextEnvelope({
    id: 'context-123',
    momentId,
    scope: createContextScope({ type: 'SIGNAL_STATE', domains: ['resume'] }),
    evidence: createSnapshotEvidenceReference({
      evidence: [
        createEvidenceReference({
          evidenceType: 'SIGNAL_SNAPSHOT',
          referenceId: 'evidence-1',
          sourceCapability: 'Resume Intelligence',
        }),
      ],
    }),
  });

  const snapshot = createSnapshot({
    id: createSnapshotIdentifier('snapshot-123'),
    subject,
    scope: 'resume',
    moment,
    context,
    version: createSnapshotVersion({ version: 1 }),
    state: createSnapshotState({
      observedFields: { resumeScore: 82 },
      sourceSignals: [createSignalReference({ signalType: 'RESUME_SIGNAL', referenceId: 'signal-1' })],
    }),
    source: createSnapshotSource({ capability: 'Resume Intelligence' }),
    confidence: createSnapshotConfidence({ score: 0.9, band: 'HIGH' }),
    trigger: createSnapshotTrigger({ origin: 'EVENT_TRIGGERED', triggerId: 'trigger-1' }),
    lifecycle: 'ACTIVE',
    supersessionState: 'CURRENT',
    metadata: createSnapshotMetadata({
      createdAt: '2026-01-01T00:00:00.000Z',
      preservedAt: '2026-01-01T00:00:01.000Z',
      origin: 'EVENT_TRIGGERED',
      visibility: 'SUBJECT',
      retentionPolicy: 'STANDARD',
      consistencyState: 'VERIFIED',
    }),
    ...overrides,
  });

  return snapshot;
}

module.exports = { buildValidSnapshot };
