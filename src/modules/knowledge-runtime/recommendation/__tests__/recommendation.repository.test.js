'use strict';

/**
 * modules/knowledge-runtime/recommendation/__tests__/recommendation.repository.test.js
 *
 * Repository tests for RecommendationRepository, exercised through the real
 * BaseRepository code path against an in-memory Supabase fake — same
 * pattern as `knowledge.repository.test.js`. Row fixtures deliberately
 * have NO `soft_deleted` column, matching the real `intelligence_recommendations`
 * schema (see recommendation.repository.js header) — this is what proves
 * the `includeDeleted: true` workaround is actually necessary and working,
 * not just documented.
 */

const { createSupabaseMock } = require('../testHelpers/supabaseMock');

jest.mock('../../../../config/supabase', () => ({
  supabase: global.__recommendationSupabaseMock,
}));

jest.mock('../../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

describe('RecommendationRepository', () => {
  let RecommendationRepository;
  let TABLE_NAME;

  const recRowA = {
    id: 'rec-1',
    entity_id: 'user-1',
    entity_type: 'student',
    output_type: 'role',
    output_key: 'role-1',
    output_label: 'Frontend Engineer',
    rank: 1,
    recommendation_score: 80,
    confidence_tier: 'HIGH',
    explanation_text: 'placeholder explanation text long enough to pass the check constraint',
    pipeline_run_id: 'run-1',
  };

  const recRowB = {
    id: 'rec-2',
    entity_id: 'user-1',
    entity_type: 'student',
    output_type: 'skill',
    output_key: 'skill-1',
    output_label: 'Python',
    rank: 2,
    recommendation_score: 70,
    confidence_tier: 'MEDIUM',
    explanation_text: 'placeholder explanation text long enough to pass the check constraint',
    pipeline_run_id: 'run-1',
  };

  const otherStudentRow = {
    ...recRowA,
    id: 'rec-3',
    entity_id: 'user-2',
  };

  beforeEach(() => {
    jest.resetModules();

    // No `soft_deleted` key on any row — matches the real
    // intelligence_recommendations schema (confirmed absent from its
    // CREATE TABLE). If findByEntity() ever stops passing
    // `includeDeleted: true`, BaseRepository's default `.eq('soft_deleted',
    // false)` filter would find no `soft_deleted` field on these rows and
    // exclude everything, so this fixture shape is itself the regression
    // guard for that documented workaround.
    global.__recommendationSupabaseMock = createSupabaseMock({
      intelligence_recommendations: [recRowA, recRowB, otherStudentRow],
    });

    ({ RecommendationRepository, TABLE_NAME } = require('../recommendation.repository'));
  });

  it('exposes the confirmed table name', () => {
    expect(TABLE_NAME).toBe('intelligence_recommendations');
  });

  describe('findByEntity', () => {
    it('returns [] when entityId is falsy', async () => {
      const repo = new RecommendationRepository();
      await expect(repo.findByEntity(null)).resolves.toEqual([]);
    });

    it('returns rows scoped to the entity and default entityType', async () => {
      const repo = new RecommendationRepository();
      const result = await repo.findByEntity('user-1');

      expect(result).toHaveLength(2);
      expect(result.map((r) => r.id).sort()).toEqual(['rec-1', 'rec-2']);
    });

    it('does not leak another entity\'s rows', async () => {
      const repo = new RecommendationRepository();
      const result = await repo.findByEntity('user-1');

      expect(result.find((r) => r.id === 'rec-3')).toBeUndefined();
    });

    it('filters by outputType when provided', async () => {
      const repo = new RecommendationRepository();
      const result = await repo.findByEntity('user-1', { outputType: 'skill' });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('rec-2');
    });

    it('respects the limit option', async () => {
      const repo = new RecommendationRepository();
      const result = await repo.findByEntity('user-1', { limit: 1 });

      expect(result).toHaveLength(1);
    });
  });
});
