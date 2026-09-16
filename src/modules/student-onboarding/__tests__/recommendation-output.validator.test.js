'use strict';

const {
  parseRecommendationOutput,
  validateRecommendationOutput,
} = require('../validators/recommendation-output.validator');

const GOVERNED_KEYS = [
  'technology', 'engineering', 'natural_sciences', 'business',
  'creative_industries', 'social_sciences', 'health_sciences', 'education',
];

function buildValidOutput(overrides = {}) {
  return {
    strengthSummary: {
      traits: ['analytical thinker'],
      academicInsights: ['strong in math'],
      exposureHighlights: ['led a robotics club'],
    },
    streamScores: [
      { stream: 'science', score: 80, label: 'Strong fit', rationale: 'strong STEM signals' },
      { stream: 'commerce', score: 40, label: 'Moderate fit', rationale: 'some business interest' },
      { stream: 'humanities', score: 20, label: 'Lower fit', rationale: 'limited humanities signal' },
    ],
    recommendedDomains: [
      {
        id: 'ai-engineering',
        title: 'AI Engineering & Data Science',
        description: 'Builds intelligent systems.',
        whyItFitsYou: 'Your strong math and coding activities point here.',
        futureScore: 90,
        aiRiskScore: 20,
        humanEdgeScore: 60,
        employabilityScore: 85,
        roiPotential: 'high',
        globalOpportunity: 'global',
        exampleRoles: ['ML Engineer', 'Data Scientist'],
        entryPaths: ['B.Tech CSE', 'Online ML specialization'],
        aiEraGuidance: 'This field is evolving rapidly and requires continuous upskilling.',
      },
    ],
    careerAreaKey: 'technology',
    futureCareerNote: 'The future favors adaptable, AI-collaborative skillsets.',
    ...overrides,
  };
}

describe('recommendation-output.validator', () => {
  describe('parseRecommendationOutput', () => {
    it('parses clean JSON', () => {
      const result = parseRecommendationOutput(JSON.stringify({ a: 1 }));
      expect(result).toEqual({ ok: true, data: { a: 1 } });
    });

    it('strips accidental markdown fences', () => {
      const result = parseRecommendationOutput('```json\n{"a":1}\n```');
      expect(result).toEqual({ ok: true, data: { a: 1 } });
    });

    it('rejects malformed JSON', () => {
      const result = parseRecommendationOutput('{not valid json');
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not valid JSON/);
    });

    it('rejects empty input', () => {
      const result = parseRecommendationOutput('');
      expect(result.ok).toBe(false);
    });
  });

  describe('validateRecommendationOutput', () => {
    it('accepts a fully valid output with a valid nullable careerAreaKey', () => {
      const result = validateRecommendationOutput(buildValidOutput(), {
        governedCareerAreaKeys: GOVERNED_KEYS,
      });
      expect(result.ok).toBe(true);
      expect(result.data.careerAreaKey).toBe('technology');
    });

    it('accepts a valid output with careerAreaKey omitted (defaults to null)', () => {
      const output = buildValidOutput();
      delete output.careerAreaKey;

      const result = validateRecommendationOutput(output, { governedCareerAreaKeys: GOVERNED_KEYS });

      expect(result.ok).toBe(true);
      expect(result.data.careerAreaKey).toBeNull();
    });

    it('accepts a valid output with careerAreaKey explicitly null', () => {
      const result = validateRecommendationOutput(buildValidOutput({ careerAreaKey: null }), {
        governedCareerAreaKeys: GOVERNED_KEYS,
      });
      expect(result.ok).toBe(true);
      expect(result.data.careerAreaKey).toBeNull();
    });

    it('rejects an invalid (non-governed) careerAreaKey', () => {
      const result = validateRecommendationOutput(
        buildValidOutput({ careerAreaKey: 'software-engineering' }),
        { governedCareerAreaKeys: GOVERNED_KEYS },
      );
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/careerAreaKey/);
    });

    it('rejects output missing required top-level fields', () => {
      const output = buildValidOutput();
      delete output.streamScores;

      const result = validateRecommendationOutput(output, { governedCareerAreaKeys: GOVERNED_KEYS });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/streamScores/);
    });

    it('rejects wrong field types', () => {
      const output = buildValidOutput();
      output.recommendedDomains[0].futureScore = 'ninety';

      const result = validateRecommendationOutput(output, { governedCareerAreaKeys: GOVERNED_KEYS });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/futureScore/);
    });

    it('rejects invalid enum values', () => {
      const output = buildValidOutput();
      output.recommendedDomains[0].roiPotential = 'astronomical';

      const result = validateRecommendationOutput(output, { governedCareerAreaKeys: GOVERNED_KEYS });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/roiPotential/);
    });

    it('rejects a structurally incomplete recommendedDomains entry', () => {
      const output = buildValidOutput();
      delete output.recommendedDomains[0].whyItFitsYou;

      const result = validateRecommendationOutput(output, { governedCareerAreaKeys: GOVERNED_KEYS });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/whyItFitsYou/);
    });

    it('never echoes the offending value in the error message', () => {
      const output = buildValidOutput();
      output.futureCareerNote = 12345; // wrong type, contains a distinctive value

      const result = validateRecommendationOutput(output, { governedCareerAreaKeys: GOVERNED_KEYS });
      expect(result.ok).toBe(false);
      expect(result.error).not.toMatch(/12345/);
    });

    it('skips governed-key membership check when no key list is supplied', () => {
      const result = validateRecommendationOutput(
        buildValidOutput({ careerAreaKey: 'anything' }),
      );
      expect(result.ok).toBe(true);
    });
  });
});
