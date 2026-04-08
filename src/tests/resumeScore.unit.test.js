'use strict';

/**
 * @file src/tests/resumeScore.unit.test.js
 * @description
 * Unit tests for pure scoring functions.
 */

const assert = require('assert');
const { describe, test } = require('node:test');

const {
  computeScoreFromParsedData,
  _scorers: {
    scoreSkills,
    scoreExperience,
    scoreRoleMatch,
    scoreEducation,
    scoreCompleteness,
  },
} = require('../services/resumeScore.service');

function makeParsedData(overrides = {}) {
  return {
    name: 'Jane Doe',
    email: 'jane@example.com',
    phone: '+91 9876543210',
    location: { city: 'Bengaluru', country: 'India' },
    linkedInUrl: 'https://linkedin.com/in/janedoe',
    skills: [
      'JavaScript',
      'React',
      'Node.js',
      'SQL',
      'Git',
      'REST APIs',
    ],
    detectedRoles: [
      { canonical: 'Software Engineer', score: 4 },
    ],
    yearsExperience: 5,
    educationLevel: "Bachelor's Degree",
    confidenceScore: 78,
    ...overrides,
  };
}

describe('resumeScore.unit', () => {
  test('scoreSkills handles monotonic growth + dedupe', () => {
    assert.strictEqual(scoreSkills([]), 0);

    const ten = scoreSkills(
      Array.from({ length: 10 }, (_, i) => `Skill${i}`)
    );
    const twenty = scoreSkills(
      Array.from({ length: 20 }, (_, i) => `Skill${i}`)
    );

    assert.ok(ten < twenty);

    const dupes = scoreSkills([
      'React',
      'React',
      'react',
    ]);
    const unique = scoreSkills(['React']);

    assert.strictEqual(dupes, unique);
  });

  test('scoreExperience is monotonic', () => {
    assert.strictEqual(scoreExperience(0), 0);
    assert.strictEqual(scoreExperience(7), 25);
    assert.ok(scoreExperience(1) < scoreExperience(5));
  });

  test('scoreRoleMatch remains bounded', () => {
    const max = scoreRoleMatch(
      [{ canonical: 'Engineer', score: 10 }],
      100
    );

    assert.ok(max <= 20);
  });

  test('computeScoreFromParsedData integrates all scorers', () => {
    const result = computeScoreFromParsedData(
      makeParsedData(),
      'user_123'
    );

    assert.strictEqual(result.isMockData, false);
    assert.strictEqual(result.userId, 'user_123');
    assert.ok(result.overallScore > 50);
    assert.strictEqual(
      result.roleFit,
      'Software Engineer'
    );
  });

  test('empty parsedData is safe', () => {
    const result = computeScoreFromParsedData(
      {},
      'user_empty'
    );

    assert.strictEqual(result.isMockData, false);
    assert.strictEqual(result.overallScore, 0);
    assert.strictEqual(result.roleFit, 'unknown');
  });
});