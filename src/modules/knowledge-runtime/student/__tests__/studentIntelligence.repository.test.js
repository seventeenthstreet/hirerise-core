'use strict';

/**
 * modules/knowledge-runtime/student/__tests__/studentIntelligence.repository.test.js
 *
 * Exercises the real BaseRepository code path against an in-memory
 * Supabase fake — same pattern as knowledge.repository.test.js.
 */

const { createSupabaseMock } = require('../../knowledge/testHelpers/supabaseMock');

jest.mock('../../../../config/supabase', () => ({
  supabase: global.__studentSupabaseMock,
}));

jest.mock('../../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

describe('StudentIntelligenceRepository', () => {
  let StudentIntelligenceRepository;

  const snapshotRowOld = {
    id: 'snap-1',
    entity_type: 'student',
    entity_id: 'user-1',
    intelligence_domain: 'student',
    pipeline_run_id: 'run-1',
    model_version_id: 'model-1',
    snapshot_trigger: 'onboarding_complete',
    snapshot_sequence: 1,
    signal_state: { a: 1 },
    domain_state: { academic: { score: 0.5 } },
    composite_confidence: 40,
    confidence_tier: 'LOW',
    data_completeness: 0.3,
    active_signal_count: 5,
    domains_included: ['academic'],
    delta_from_previous: null,
    state_hash: 'a'.repeat(64),
    snapshot_at: '2026-05-01T00:00:00.000Z',
  };

  const snapshotRowNew = {
    ...snapshotRowOld,
    id: 'snap-2',
    snapshot_sequence: 2,
    composite_confidence: 70,
    confidence_tier: 'MEDIUM',
    snapshot_at: '2026-06-01T00:00:00.000Z',
  };

  beforeEach(() => {
    jest.resetModules();

    global.__studentSupabaseMock = createSupabaseMock({
      intelligence_entity_snapshots: [snapshotRowOld, snapshotRowNew],
    });

    ({ StudentIntelligenceRepository } = require('../studentIntelligence.repository'));
  });

  describe('findLatestSnapshot', () => {
    it('returns null when userId is falsy', async () => {
      const repo = new StudentIntelligenceRepository();
      await expect(repo.findLatestSnapshot(null)).resolves.toBeNull();
    });

    it('returns the highest-sequence snapshot for the student', async () => {
      const repo = new StudentIntelligenceRepository();
      const result = await repo.findLatestSnapshot('user-1');

      expect(result).toEqual(expect.objectContaining({
        id: 'snap-2',
        snapshotSequence: 2,
        compositeConfidence: 70,
      }));
    });

    it('returns null for a student with no snapshots', async () => {
      const repo = new StudentIntelligenceRepository();
      const result = await repo.findLatestSnapshot('user-does-not-exist');

      expect(result).toBeNull();
    });
  });

  describe('findSnapshotHistory', () => {
    it('returns an empty array when userId is falsy', async () => {
      const repo = new StudentIntelligenceRepository();
      await expect(repo.findSnapshotHistory(null)).resolves.toEqual([]);
    });

    it('returns snapshots for the student, most recent first, bounded by limit', async () => {
      const repo = new StudentIntelligenceRepository();
      const result = await repo.findSnapshotHistory('user-1', { limit: 1 });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('snap-2');
    });
  });

  describe('insertSnapshot', () => {
    it('throws AppError when required fields are missing', async () => {
      const repo = new StudentIntelligenceRepository();
      await expect(repo.insertSnapshot({ userId: 'user-1' })).rejects.toThrow();
    });

    it('inserts and returns the normalized row when all required fields are present', async () => {
      const repo = new StudentIntelligenceRepository();
      const result = await repo.insertSnapshot({
        userId: 'user-1',
        pipelineRunId: 'run-2',
        modelVersionId: 'model-2',
        snapshotTrigger: 'manual_request',
        snapshotSequence: 3,
        stateHash: 'b'.repeat(64),
      });

      expect(result).toEqual(expect.objectContaining({
        entityId: 'user-1',
        pipelineRunId: 'run-2',
        snapshotSequence: 3,
      }));
    });
  });
});
