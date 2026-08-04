'use strict';

/**
 * @file core-work/src/modules/snapshot-intelligence/__tests__/snapshot.validation.test.js
 * KR-02A — Snapshot Domain Foundation — Domain validation tests
 */

const validation = require('../domain/schemas/snapshot.validation');
const { SnapshotValidationError } = require('../domain/errors/snapshot.errors');

const validSubject = { subjectType: 'STUDENT', subjectId: 'student-1' };
const validTimestamp = { occurredAt: '2026-01-01T00:00:00.000Z' };
const validReason = { code: 'RESUME_UPDATED' };

describe('SubjectReference validation', () => {
  it('accepts a valid subject reference', () => {
    expect(() => validation.validateSubjectReference(validSubject)).not.toThrow();
  });

  it('rejects an invalid subjectType', () => {
    expect(() => validation.validateSubjectReference({ subjectType: 'OTHER', subjectId: 'x' }))
      .toThrow(SnapshotValidationError);
  });

  it('rejects a missing subjectId', () => {
    expect(() => validation.validateSubjectReference({ subjectType: 'STUDENT' }))
      .toThrow(SnapshotValidationError);
  });
});

describe('SnapshotConfidence validation', () => {
  it('accepts a score within [0,1]', () => {
    expect(() => validation.validateSnapshotConfidence({ score: 0.5 })).not.toThrow();
  });

  it('rejects a score above 1', () => {
    expect(() => validation.validateSnapshotConfidence({ score: 1.5 })).toThrow(SnapshotValidationError);
  });

  it('rejects an invalid band', () => {
    expect(() => validation.validateSnapshotConfidence({ score: 0.5, band: 'EXTREME' }))
      .toThrow(SnapshotValidationError);
  });
});

describe('Moment validation', () => {
  const validMoment = {
    id: 'moment-1',
    subject: validSubject,
    momentType: 'resume-updated',
    momentCategory: 'resume',
    classification: 'MILESTONE',
    timestamp: validTimestamp,
    reason: validReason,
  };

  it('accepts a fully valid moment', () => {
    expect(() => validation.validateMoment(validMoment)).not.toThrow();
  });

  it('rejects an invalid classification', () => {
    expect(() => validation.validateMoment({ ...validMoment, classification: 'NOT_REAL' }))
      .toThrow(SnapshotValidationError);
  });
});

describe('SnapshotEvidenceReference validation', () => {
  it('rejects duplicate evidence referenceId values', () => {
    const evidence = {
      evidence: [
        { evidenceType: 'SIGNAL_SNAPSHOT', referenceId: 'e-1', sourceCapability: 'Career Metrics' },
        { evidenceType: 'SIGNAL_SNAPSHOT', referenceId: 'e-1', sourceCapability: 'Career Metrics' },
      ],
    };
    expect(() => validation.validateSnapshotEvidenceReference(evidence)).toThrow(SnapshotValidationError);
  });

  it('accepts unique evidence referenceId values', () => {
    const evidence = {
      evidence: [
        { evidenceType: 'SIGNAL_SNAPSHOT', referenceId: 'e-1', sourceCapability: 'Career Metrics' },
        { evidenceType: 'SIGNAL_SNAPSHOT', referenceId: 'e-2', sourceCapability: 'Career Metrics' },
      ],
    };
    expect(() => validation.validateSnapshotEvidenceReference(evidence)).not.toThrow();
  });
});

describe('validation is deterministic', () => {
  it('produces the same result across repeated calls with the same input', () => {
    const input = { score: 0.42, band: 'MEDIUM' };
    const results = Array.from({ length: 5 }, () => {
      try {
        validation.validateSnapshotConfidence(input);
        return 'valid';
      } catch (e) {
        return e.message;
      }
    });
    expect(new Set(results).size).toBe(1);
  });
});
