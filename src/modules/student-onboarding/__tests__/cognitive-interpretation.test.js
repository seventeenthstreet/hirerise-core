'use strict';

/**
 * __tests__/cognitive-interpretation.test.js
 *
 * Phase 3B.4B — Student-Native Cognitive Interpretation.
 * Unit tests for the pure interpretation layer. No mocking needed —
 * signals/cognitive.interpretation.js performs no I/O.
 */

const {
  interpretCognitiveSignals,
  rankDomains,
  computeDomainAverage,
} = require('../signals/cognitive.interpretation');

const {
  COGNITIVE_DOMAINS,
  ALL_COGNITIVE_SIGNAL_TAGS,
  SIGNAL_WEIGHT_NOISE_FLOOR,
} = require('../constants/cognitive');

// Small helper: build a domain_vectors object with one weight per domain.
function buildDomainVectors(weightsByDomain, dominantTagsByDomain = {}) {
  const vectors = {};
  for (const [domain, weights] of Object.entries(weightsByDomain)) {
    vectors[domain] = {
      domain,
      weights,
      dominant_tags: dominantTagsByDomain[domain] ?? [],
    };
  }
  return vectors;
}

describe('cognitive.interpretation', () => {
  describe('computeDomainAverage', () => {
    it('averages numeric weights', () => {
      expect(computeDomainAverage({ a: 0.4, b: 0.6 })).toBe(0.5);
    });

    it('returns null for an empty/missing weights object (no usable data)', () => {
      expect(computeDomainAverage({})).toBeNull();
      expect(computeDomainAverage(undefined)).toBeNull();
      expect(computeDomainAverage(null)).toBeNull();
    });

    it('treats a genuine zero weight as usable data, not "no data"', () => {
      expect(computeDomainAverage({ a: 0 })).toBe(0);
    });

    it('does not sum (average of two equal weights is that weight, not double it)', () => {
      expect(computeDomainAverage({ a: 0.5, b: 0.5 })).toBe(0.5);
    });
  });

  describe('rankDomains — domain ranking', () => {
    it('each of the five domains can become dominant when it has the highest average', () => {
      for (const winner of COGNITIVE_DOMAINS) {
        const weightsByDomain = {};
        for (const domain of COGNITIVE_DOMAINS) {
          weightsByDomain[domain] = { tag: domain === winner ? 0.9 : 0.2 };
        }
        const ranked = rankDomains(buildDomainVectors(weightsByDomain));
        expect(ranked[0].domain).toBe(winner);
      }
    });

    it('highest average wins regardless of how many tags a domain has', () => {
      // problem_solving has 7 canonical tags, decision_making has 5 — verify
      // that tag *count* does not bias the winner, only the average value.
      const vectors = buildDomainVectors({
        problem_solving: { a: 0.4, b: 0.4, c: 0.4, d: 0.4, e: 0.4, f: 0.4, g: 0.4 }, // avg 0.4, 7 tags
        decision_making: { a: 0.5, b: 0.5 }, // avg 0.5, 2 tags
      });
      const ranked = rankDomains(vectors);
      expect(ranked[0].domain).toBe('decision_making');
    });

    it('excludes a domain with no usable vector data from ranking entirely', () => {
      const vectors = buildDomainVectors({
        problem_solving: { a: 0.5 },
        learning_preference: {}, // no usable weights
      });
      const ranked = rankDomains(vectors);
      expect(ranked).toHaveLength(1);
      expect(ranked[0].domain).toBe('problem_solving');
    });

    it('handles a genuine zero-valued domain as real data (included, ranked low)', () => {
      const vectors = buildDomainVectors({
        problem_solving: { a: 0.8 },
        learning_preference: { a: 0 },
      });
      const ranked = rankDomains(vectors);
      expect(ranked.map((r) => r.domain)).toEqual(['problem_solving', 'learning_preference']);
    });

    it('returns an empty list when all domains lack usable data', () => {
      const vectors = buildDomainVectors({
        problem_solving: {},
        learning_preference: {},
      });
      expect(rankDomains(vectors)).toEqual([]);
    });
  });

  describe('rankDomains — ties', () => {
    it('breaks a domain tie using COGNITIVE_DOMAINS declared order', () => {
      // execution_pattern is declared after decision_making in COGNITIVE_DOMAINS.
      const vectors = buildDomainVectors({
        execution_pattern: { a: 0.5 },
        decision_making: { a: 0.5 },
      });
      const ranked = rankDomains(vectors);
      expect(ranked.map((r) => r.domain)).toEqual(['decision_making', 'execution_pattern']);
    });

    it('preserves canonical tag ordering already present on dominant_tags (no re-sort)', () => {
      const vectors = buildDomainVectors(
        { problem_solving: { a: 0.5 } },
        { problem_solving: ['iterative', 'analytical'] }, // deliberately not alphabetical
      );
      const ranked = rankDomains(vectors);
      expect(ranked[0].dominant_tags).toEqual(['iterative', 'analytical']);
    });
  });

  describe('interpretCognitiveSignals — dominant tags reuse', () => {
    it('reuses per-domain dominant_tags as-is (no recalculation)', () => {
      const cognitiveSignals = {
        domain_vectors: buildDomainVectors(
          { problem_solving: { analytical: 0.9, experimental: 0.1 } },
          { problem_solving: ['analytical'] },
        ),
        signal_weights: { analytical: 0.9, experimental: 0.1 },
        signal_tags: ['analytical'],
        response_count: 3,
        is_partial: false,
        metadata: { extraction_version: '3c.1.0' },
      };

      const result = interpretCognitiveSignals(cognitiveSignals);
      expect(result.ranked_domains[0].dominant_tags).toEqual(['analytical']);
      expect(result.signal_tags).toEqual(['analytical']);
    });

    it('respects the existing 0.3 inclusive noise floor via pass-through, not recomputation', () => {
      // Exactly-at-floor and below-floor tags, as they would already be
      // filtered by cognitive.signals.js before reaching this module.
      expect(SIGNAL_WEIGHT_NOISE_FLOOR).toBe(0.3);

      const cognitiveSignals = {
        domain_vectors: buildDomainVectors(
          { problem_solving: { analytical: 0.3, experimental: 0.2999 } },
          { problem_solving: ['analytical'] }, // only the >=0.3 tag survives upstream
        ),
        signal_weights: { analytical: 0.3, experimental: 0.2999 },
        signal_tags: ['analytical'],
        response_count: 1,
        is_partial: false,
        metadata: { extraction_version: '3c.1.0' },
      };

      const result = interpretCognitiveSignals(cognitiveSignals);
      expect(result.signal_tags).toEqual(['analytical']);
      expect(result.signal_tags).not.toContain('experimental');
    });

    it('does not introduce any secondary tendency tier', () => {
      const result = interpretCognitiveSignals({
        domain_vectors: buildDomainVectors({ problem_solving: { analytical: 0.5 } }),
        signal_tags: ['analytical'],
        response_count: 1,
        is_partial: false,
        metadata: {},
      });
      expect(result).not.toHaveProperty('secondary_tags');
      expect(result).not.toHaveProperty('secondary_tendencies');
    });
  });

  describe('interpretCognitiveSignals — output contract', () => {
    it('is deterministic across repeated calls with identical input', () => {
      const cognitiveSignals = {
        domain_vectors: buildDomainVectors({
          problem_solving: { analytical: 0.6, experimental: 0.3 },
          decision_making: { fast_decider: 0.6 },
        }),
        signal_tags: ['analytical', 'fast_decider'],
        response_count: 5,
        is_partial: false,
        metadata: { extraction_version: '3c.1.0' },
      };

      const first = interpretCognitiveSignals(cognitiveSignals);
      const second = interpretCognitiveSignals(cognitiveSignals);
      expect(second).toEqual(first);
    });

    it('does not mutate the source input', () => {
      const cognitiveSignals = {
        domain_vectors: buildDomainVectors({ problem_solving: { analytical: 0.6 } }),
        signal_tags: ['analytical'],
        response_count: 1,
        is_partial: false,
        metadata: { extraction_version: '3c.1.0' },
      };
      const snapshot = JSON.parse(JSON.stringify(cognitiveSignals));

      interpretCognitiveSignals(cognitiveSignals);

      expect(cognitiveSignals).toEqual(snapshot);
    });

    it('preserves response_count, is_partial, and extraction_version', () => {
      const result = interpretCognitiveSignals({
        domain_vectors: buildDomainVectors({ problem_solving: { analytical: 0.6 } }),
        signal_tags: ['analytical'],
        response_count: 7,
        is_partial: true,
        metadata: { extraction_version: '3c.1.0' },
      });

      expect(result.response_count).toBe(7);
      expect(result.is_partial).toBe(true);
      expect(result.extraction_version).toBe('3c.1.0');
    });

    it('handles empty input without crashing (empty/zero-response student)', () => {
      const result = interpretCognitiveSignals({
        domain_vectors: {},
        signal_tags: [],
        response_count: 0,
        is_partial: true,
        metadata: {},
      });

      expect(result.ranked_domains).toEqual([]);
      expect(result.dominant_domain).toBeNull();
      expect(result.signal_tags).toEqual([]);
      expect(result.response_count).toBe(0);
      expect(result.is_partial).toBe(true);
      expect(result.extraction_version).toBeNull();
    });

    it('handles undefined/null cognitiveSignals gracefully', () => {
      expect(() => interpretCognitiveSignals(undefined)).not.toThrow();
      expect(() => interpretCognitiveSignals(null)).not.toThrow();
      const result = interpretCognitiveSignals(null);
      expect(result.dominant_domain).toBeNull();
      expect(result.ranked_domains).toEqual([]);
    });

    it('does not leak unrelated database fields into the output', () => {
      const result = interpretCognitiveSignals({
        id: 'row-id-should-not-leak',
        user_id: 'user-id-should-not-leak',
        domain_vectors: buildDomainVectors({ problem_solving: { analytical: 0.6 } }),
        signal_weights: { analytical: 0.6 },
        signal_tags: ['analytical'],
        response_count: 1,
        is_partial: false,
        engine_version: null,
        extracted_at: '2026-01-01T00:00:00.000Z',
        metadata: { extraction_version: '3c.1.0' },
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      });

      expect(Object.keys(result).sort()).toEqual(
        [
          'ranked_domains',
          'dominant_domain',
          'signal_tags',
          'response_count',
          'is_partial',
          'extraction_version',
        ].sort(),
      );
    });
  });

  describe('taxonomy safety (Family #1 stale-tag regression guard)', () => {
    it('every emitted ranked domain is a member of COGNITIVE_DOMAINS', () => {
      const vectors = buildDomainVectors({
        problem_solving: { a: 0.5 },
        decision_making: { a: 0.5 },
      });
      const ranked = rankDomains(vectors);
      for (const entry of ranked) {
        expect(COGNITIVE_DOMAINS).toContain(entry.domain);
      }
    });

    it('drops any signal_tags entries that are not real canonical tags', () => {
      // Mirrors the Family #1 defect class (e.g. stale tags like
      // 'big_picture'/'context_first'/'pattern_recognition' that are not
      // members of ALL_COGNITIVE_SIGNAL_TAGS) — must never pass through.
      const result = interpretCognitiveSignals({
        domain_vectors: {},
        signal_tags: ['analytical', 'big_picture', 'context_first', 'pattern_recognition'],
        response_count: 1,
        is_partial: false,
        metadata: {},
      });

      expect(result.signal_tags).toEqual(['analytical']);
      for (const tag of result.signal_tags) {
        expect(ALL_COGNITIVE_SIGNAL_TAGS).toContain(tag);
      }
    });
  });

  describe('semantic safety', () => {
    it('never emits score/aptitude/IQ/diagnosis-style keys anywhere in the output', () => {
      const result = interpretCognitiveSignals({
        domain_vectors: buildDomainVectors({ problem_solving: { analytical: 0.6 } }),
        signal_tags: ['analytical'],
        response_count: 1,
        is_partial: false,
        metadata: { extraction_version: '3c.1.0' },
      });

      const banned = ['score', 'aptitude', 'iq', 'intelligence', 'personality', 'diagnosis', 'assessment'];
      const serialized = JSON.stringify(result).toLowerCase();

      for (const term of banned) {
        expect(serialized.includes(term)).toBe(false);
      }
    });
  });
});
