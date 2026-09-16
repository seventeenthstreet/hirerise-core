'use strict';

/**
 * modules/student-onboarding/__tests__/aspiration-aggregation.test.js
 *
 * Phase 3B.5B — Aspiration Signalization
 *
 * MANDATORY REGRESSION SAFEGUARD (see cross-domain.aggregator.js
 * _buildDomainVectors): Aspiration contributions must be routed to
 * domain_vectors.aspiration and must NEVER fall through to
 * domain_vectors.cross_domain.
 *
 * Also verifies existing academic/activity/cognitive/cross_domain
 * aggregation behavior is unchanged by the Aspiration addition.
 *
 * Pure function tests — no mocking required.
 */

const {
  aggregateCrossDomainSignals,
  _buildDomainVectors,
} = require('../signals/cross-domain.aggregator');

const { normalizeAspirationSignals } = require('../signals/domain-normalizers');

function aspirationContribution(signalKey, refId, overrides = {}) {
  return {
    signal_key:             signalKey,
    source_type:            'explicit_response',
    source_domain:          'aspiration',
    source_reference_id:    refId,
    source_reference_table: 'student_aspirations',
    contribution_weight:    1.0,
    evidence_metadata:      {},
    taxonomy_version:       'v1',
    aggregation_version:    'v1',
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ASPIRATION-ONLY ISOLATION — the mandatory regression test
// ─────────────────────────────────────────────────────────────────────────────

describe('Aspiration-only isolation (mandatory regression safeguard)', () => {
  it('routes Aspiration contributions to domain_vectors.aspiration, never domain_vectors.cross_domain', () => {
    const domainContributions = {
      academic:   [],
      activity:   [],
      cognitive:  [],
      aspiration: [
        aspirationContribution('career_interest_engineering', 'aspiration_career_interest_engineering'),
        aspirationContribution('career_value_impact', 'aspiration_motivation_driver_impact'),
      ],
    };

    const bundle = aggregateCrossDomainSignals('user-1', domainContributions);

    expect(bundle.domain_vectors.aspiration).toEqual({
      career_interest_engineering: 1.0,
      career_value_impact:         1.0,
    });
    expect(bundle.domain_vectors.cross_domain).toEqual({});
  });

  it('produces Aspiration signal_weights but no Academic/Activity/Cognitive signals', () => {
    const domainContributions = {
      academic:   [],
      activity:   [],
      cognitive:  [],
      aspiration: [aspirationContribution('career_interest_law', 'aspiration_career_interest_law')],
    };

    const bundle = aggregateCrossDomainSignals('user-1', domainContributions);

    expect(bundle.signal_weights).toEqual({ career_interest_law: 1.0 });
    expect(Object.keys(bundle.domain_vectors.academic)).toHaveLength(0);
    expect(Object.keys(bundle.domain_vectors.activity)).toHaveLength(0);
    expect(Object.keys(bundle.domain_vectors.cognitive)).toHaveLength(0);
  });

  it('reports "aspiration" in domains_included when Aspiration contributed evidence', () => {
    const domainContributions = {
      academic:   [],
      activity:   [],
      cognitive:  [],
      aspiration: [aspirationContribution('career_interest_business', 'aspiration_career_interest_business')],
    };

    const bundle = aggregateCrossDomainSignals('user-1', domainContributions);
    expect(bundle.domains_included).toContain('aspiration');
  });

  it('_buildDomainVectors gives Aspiration its own explicit bucket even with zero contributions', () => {
    const vectors = _buildDomainVectors({ academic: [], activity: [], cognitive: [], aspiration: [] }, {});
    expect(vectors).toHaveProperty('aspiration');
    expect(vectors.aspiration).toEqual({});
    expect(vectors.cross_domain).toEqual({});
  });

  it('an unrecognized domain key (not aspiration/academic/activity/cognitive) still falls through to cross_domain — existing behavior unchanged', () => {
    const vectors = _buildDomainVectors(
      { some_future_domain: [aspirationContribution('career_interest_science', 'ref')] },
      { career_interest_science: 1.0 },
    );
    // Confirms cross_domain fallthrough still exists for genuinely unknown
    // domain keys — Aspiration is explicitly excluded from that fallthrough,
    // not the fallthrough itself removed.
    expect(vectors.cross_domain).toEqual({ career_interest_science: 1.0 });
    expect(vectors.aspiration).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CONFIDENCE / REINFORCEMENT ISOLATION
// ─────────────────────────────────────────────────────────────────────────────

describe('Aspiration confidence isolation — no cross-domain reinforcement', () => {
  it('an Aspiration-only signal has cross_domain_reinforcement = false and composite_confidence = null', () => {
    const domainContributions = {
      academic:   [],
      activity:   [],
      cognitive:  [],
      aspiration: [aspirationContribution('career_value_autonomy', 'aspiration_motivation_driver_autonomy')],
    };

    const bundle = aggregateCrossDomainSignals('user-1', domainContributions);
    const conf = bundle.confidence_data.career_value_autonomy;

    expect(conf.cross_domain_reinforcement).toBe(false);
    expect(conf.composite_confidence).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// END-TO-END NORMALIZER → AGGREGATOR WIRING
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeAspirationSignals output flows correctly into the aggregator', () => {
  it('multiple career interests + a motivation driver all land in domain_vectors.aspiration', () => {
    const contributions = normalizeAspirationSignals('user-1', {
      career_interests:  ['engineering', 'science'],
      motivation_driver: 'impact',
      time_horizon:      'medium',
    });

    const bundle = aggregateCrossDomainSignals('user-1', {
      academic: [], activity: [], cognitive: [], aspiration: contributions,
    });

    expect(bundle.domain_vectors.aspiration).toEqual({
      career_interest_engineering: 1.0,
      career_interest_science:     1.0,
      career_value_impact:         1.0,
    });
    expect(bundle.domain_vectors.cross_domain).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EXISTING DOMAIN BEHAVIOR UNCHANGED
// ─────────────────────────────────────────────────────────────────────────────

describe('existing academic/activity/cognitive/cross_domain aggregation is unaffected by the Aspiration addition', () => {
  it('academic-only contributions still land in domain_vectors.academic (not aspiration/cross_domain)', () => {
    const domainContributions = {
      academic: [
        {
          signal_key: 'analytical_strength',
          source_type: 'subject_performance',
          source_domain: 'academic',
          source_reference_id: 'ref-1',
          source_reference_table: 'student_academic_subjects',
          contribution_weight: 0.8,
          evidence_metadata: {},
          taxonomy_version: 'v1',
          aggregation_version: 'v1',
        },
      ],
      activity: [],
      cognitive: [],
      aspiration: [],
    };

    const bundle = aggregateCrossDomainSignals('user-1', domainContributions);

    expect(bundle.domain_vectors.academic).toHaveProperty('analytical_strength');
    expect(bundle.domain_vectors.aspiration).toEqual({});
    expect(bundle.domain_vectors.cross_domain).toEqual({});
  });

  it('a true cross_domain-primary signal (e.g. stem_affinity) still populates domain_vectors.cross_domain', () => {
    const domainContributions = {
      academic: [
        {
          signal_key: 'stem_affinity',
          source_type: 'subject_performance',
          source_domain: 'academic',
          source_reference_id: 'ref-2',
          source_reference_table: 'student_academic_subjects',
          contribution_weight: 0.9,
          evidence_metadata: {},
          taxonomy_version: 'v1',
          aggregation_version: 'v1',
        },
      ],
      activity: [], cognitive: [], aspiration: [],
    };

    const bundle = aggregateCrossDomainSignals('user-1', domainContributions);
    expect(bundle.domain_vectors.cross_domain).toHaveProperty('stem_affinity');
  });

  it('omitting domainContributions.aspiration entirely does not throw (backward compatible call shape)', () => {
    expect(() =>
      aggregateCrossDomainSignals('user-1', { academic: [], activity: [], cognitive: [] }),
    ).not.toThrow();
  });
});
