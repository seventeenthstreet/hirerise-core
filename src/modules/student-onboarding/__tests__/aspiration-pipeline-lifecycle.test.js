'use strict';

/**
 * modules/student-onboarding/__tests__/aspiration-pipeline-lifecycle.test.js
 *
 * Phase 3B.5B — Aspiration Signalization
 *
 * Exercises the REAL runIntelligencePipeline() end-to-end (normalizer →
 * aggregator → dedup → evidence persistence → vector upsert), against an
 * in-memory fake of intelligence.repository.js standing in for Supabase
 * (no live database is available in this environment — see the
 * accompanying verification report's Database Verification section).
 *
 * The fake faithfully reproduces the real repository's documented
 * contracts:
 *   - student_signal_evidence is APPEND-ONLY, deduplicated by
 *     (user_id, signal_key, source_reference_id, aggregation_version).
 *   - student_signal_vectors is UPSERTED (one row per user_id +
 *     aggregation_version) — i.e. it always reflects only the CURRENT run's
 *     aggregated bundle, never a merge with historical evidence.
 *
 * Covers contract sections:
 *   §12 Current-state lifecycle test (career interests)
 *   §13 Motivation current-state test
 *   §14 Idempotency test
 *   §15 Aspiration-only isolation test
 */

jest.mock('../../../../shared/logger', () => ({
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

// ─────────────────────────────────────────────────────────────────────────────
// FAKE intelligence.repository.js — in-memory, contract-faithful
// ─────────────────────────────────────────────────────────────────────────────

let mockEvidenceStore = []; // [{ user_id, signal_key, source_reference_id, aggregation_version, ... }]
let mockVectorStore   = {}; // key: `${userId}__${aggregationVersion}` -> bundle-derived row
let mockConfidenceRows = [];

jest.mock('../repositories/intelligence.repository', () => {
  class StudentSignalEvidenceRepository {
    async getExistingReferenceKeys(userId, aggregationVersion) {
      return new Set(
        mockEvidenceStore
          .filter((r) => r.user_id === userId && r.aggregation_version === aggregationVersion)
          .map((r) => `${r.signal_key}__${r.source_reference_id}__${r.aggregation_version}`),
      );
    }

    async bulkInsertEvidence(userId, contributions) {
      const now = new Date().toISOString();
      for (const c of contributions) {
        mockEvidenceStore.push({
          user_id:                userId,
          signal_key:             c.signal_key,
          source_reference_id:    c.source_reference_id,
          source_domain:          c.source_domain,
          aggregation_version:    c.aggregation_version,
          contribution_weight:    c.contribution_weight,
          recorded_at:            now,
        });
      }
      return contributions.length;
    }

    async findByUserAndSignal(userId, signalKey) {
      return mockEvidenceStore.filter((r) => r.user_id === userId && r.signal_key === signalKey);
    }
  }

  class StudentSignalVectorRepository {
    async upsertVector(userId, bundle) {
      const key = `${userId}__${bundle.aggregation_version}`;
      mockVectorStore[key] = { user_id: userId, ...bundle };
      return key;
    }

    async findByUser(userId, aggregationVersion) {
      return mockVectorStore[`${userId}__${aggregationVersion}`] ?? null;
    }
  }

  class SignalConfidenceRepository {
    async upsertBundleConfidence(userId, bundle) {
      const rows = Object.entries(bundle.confidence_data ?? {});
      mockConfidenceRows.push(...rows.map(([signalKey]) => ({ user_id: userId, signal_key: signalKey })));
      return rows.length;
    }

    async findByUser(userId) {
      return mockConfidenceRows.filter((r) => r.user_id === userId);
    }
  }

  class SignalRegistryRepository {
    async findAllActive() { return []; }
  }

  return {
    SignalRegistryRepository,
    StudentSignalVectorRepository,
    StudentSignalEvidenceRepository,
    SignalConfidenceRepository,
  };
});

const { runIntelligencePipeline } = require('../services/intelligence.service');
const { AGGREGATION_VERSION } = require('../constants/intelligence');

function aspirationRawData(careerInterests = [], motivationDriver = null, timeHorizon = null) {
  return {
    academics:  { years: {} },
    activities: { activities: [], achievements: [], reflection: null },
    cognitive:  { responses: [], taxonomyRows: [] },
    aspiration: {
      career_interests:  careerInterests,
      motivation_driver: motivationDriver,
      time_horizon:      timeHorizon,
    },
  };
}

beforeEach(() => {
  mockEvidenceStore   = [];
  mockVectorStore     = {};
  mockConfidenceRows  = [];
});

// ─────────────────────────────────────────────────────────────────────────────
// §12 CURRENT-STATE LIFECYCLE TEST — career interests
// ─────────────────────────────────────────────────────────────────────────────

describe('§12 current-state lifecycle — career interests change over time', () => {
  it('first state (engineering + science) produces the expected current vector', async () => {
    const userId = 'user-lifecycle-1';
    const { bundle } = await runIntelligencePipeline(
      userId,
      aspirationRawData(['engineering', 'science']),
      { pipelineRunId: 'run-1' },
    );

    expect(bundle.domain_vectors.aspiration).toEqual({
      career_interest_engineering: 1.0,
      career_interest_science:     1.0,
    });
  });

  it('second run with the canonical source changed to law: current vector shows ONLY law; engineering/science evidence is preserved historically', async () => {
    const userId = 'user-lifecycle-1';

    await runIntelligencePipeline(userId, aspirationRawData(['engineering', 'science']), { pipelineRunId: 'run-1' });
    const { bundle: secondBundle } = await runIntelligencePipeline(
      userId,
      aspirationRawData(['law']),
      { pipelineRunId: 'run-2' },
    );

    // Current vector reflects only the new canonical state
    expect(secondBundle.domain_vectors.aspiration).toEqual({ career_interest_law: 1.0 });
    expect(secondBundle.domain_vectors.aspiration).not.toHaveProperty('career_interest_engineering');
    expect(secondBundle.domain_vectors.aspiration).not.toHaveProperty('career_interest_science');

    // The persisted "current" vector row matches
    const currentVector = mockVectorStore[`${userId}__${AGGREGATION_VERSION}`];
    expect(currentVector.domain_vectors.aspiration).toEqual({ career_interest_law: 1.0 });

    // Historical evidence for engineering/science must remain (append-only)
    const engineeringEvidence = mockEvidenceStore.filter(
      (r) => r.user_id === userId && r.signal_key === 'career_interest_engineering',
    );
    const scienceEvidence = mockEvidenceStore.filter(
      (r) => r.user_id === userId && r.signal_key === 'career_interest_science',
    );
    const lawEvidence = mockEvidenceStore.filter(
      (r) => r.user_id === userId && r.signal_key === 'career_interest_law',
    );
    expect(engineeringEvidence).toHaveLength(1);
    expect(scienceEvidence).toHaveLength(1);
    expect(lawEvidence).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §13 MOTIVATION CURRENT-STATE TEST
// ─────────────────────────────────────────────────────────────────────────────

describe('§13 current-state lifecycle — motivation driver changes over time', () => {
  it('impact then autonomy: current vector shows only autonomy; impact evidence remains historically', async () => {
    const userId = 'user-lifecycle-2';

    await runIntelligencePipeline(userId, aspirationRawData([], 'impact'), { pipelineRunId: 'run-1' });
    const { bundle } = await runIntelligencePipeline(userId, aspirationRawData([], 'autonomy'), { pipelineRunId: 'run-2' });

    expect(bundle.domain_vectors.aspiration).toEqual({ career_value_autonomy: 1.0 });
    expect(bundle.domain_vectors.aspiration).not.toHaveProperty('career_value_impact');

    const impactEvidence   = mockEvidenceStore.filter((r) => r.user_id === userId && r.signal_key === 'career_value_impact');
    const autonomyEvidence = mockEvidenceStore.filter((r) => r.user_id === userId && r.signal_key === 'career_value_autonomy');
    expect(impactEvidence).toHaveLength(1);
    expect(autonomyEvidence).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §14 IDEMPOTENCY TEST
// ─────────────────────────────────────────────────────────────────────────────

describe('§14 idempotency — identical current Aspiration data run three times', () => {
  it('creates evidence once; second/third runs create no duplicates; current vector stable', async () => {
    const userId = 'user-idempotent-1';
    const data = aspirationRawData(['engineering', 'science'], 'impact');

    const run1 = await runIntelligencePipeline(userId, data, { pipelineRunId: 'run-1' });
    expect(run1.evidenceInserted).toBe(3); // 2 career interests + 1 motivation

    const run2 = await runIntelligencePipeline(userId, data, { pipelineRunId: 'run-2' });
    expect(run2.evidenceInserted).toBe(0);

    const run3 = await runIntelligencePipeline(userId, data, { pipelineRunId: 'run-3' });
    expect(run3.evidenceInserted).toBe(0);

    const aspirationEvidenceCount = mockEvidenceStore.filter(
      (r) => r.user_id === userId && r.source_domain === 'aspiration',
    ).length;
    expect(aspirationEvidenceCount).toBe(3);

    // Current vector remains identical across all three runs
    expect(run1.bundle.domain_vectors.aspiration).toEqual(run2.bundle.domain_vectors.aspiration);
    expect(run2.bundle.domain_vectors.aspiration).toEqual(run3.bundle.domain_vectors.aspiration);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §15 ASPIRATION-ONLY ISOLATION TEST
// ─────────────────────────────────────────────────────────────────────────────

describe('§15 Aspiration-only isolation', () => {
  it('with only Aspiration data present: Aspiration signals YES, academic/activity/cognitive/cross_domain NO', async () => {
    const userId = 'user-isolation-1';
    const { bundle } = await runIntelligencePipeline(
      userId,
      aspirationRawData(['medicine'], 'passion'),
      { pipelineRunId: 'run-1' },
    );

    expect(Object.keys(bundle.domain_vectors.aspiration).length).toBeGreaterThan(0);
    expect(bundle.domain_vectors.academic).toEqual({});
    expect(bundle.domain_vectors.activity).toEqual({});
    expect(bundle.domain_vectors.cognitive).toEqual({});
    expect(bundle.domain_vectors.cross_domain).toEqual({});
    expect(bundle.domains_included).toEqual(['aspiration']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PROVENANCE — persisted evidence rows
// ─────────────────────────────────────────────────────────────────────────────

describe('persisted evidence rows carry correct provenance', () => {
  it('every persisted Aspiration evidence row has source_domain=aspiration and the deterministic reference id', async () => {
    const userId = 'user-provenance-1';
    await runIntelligencePipeline(userId, aspirationRawData(['business'], 'financial'), { pipelineRunId: 'run-1' });

    const rows = mockEvidenceStore.filter((r) => r.user_id === userId);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.source_domain).toBe('aspiration');
    }
    expect(rows.find((r) => r.signal_key === 'career_interest_business').source_reference_id)
      .toBe('aspiration_career_interest_business');
    expect(rows.find((r) => r.signal_key === 'career_value_financial').source_reference_id)
      .toBe('aspiration_motivation_driver_financial');
  });
});
