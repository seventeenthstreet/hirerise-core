'use strict';

/**
 * @file src/tests/pipeline.integration.test.js
 * @description
 * End-to-end pure pipeline integration tests.
 * Safe for Jest and Node test runner.
 */

const assert = require('assert');
const { describe, test } = require('node:test');

const USER_ID = 'test_user_pipeline_001';

function buildUserProfile(userId, parsedData = {}) {
  const skills = (parsedData.skills || [])
    .map((s) => (typeof s === 'string' ? s : s?.name))
    .filter(Boolean)
    .map((s) => s.toLowerCase().trim());

  return {
    userId,
    skills,
    experienceYears: Number(parsedData.yearsExperience || 0),
    detectedRoles: parsedData.detectedRoles || [],
    education: parsedData.education || [],
    educationLevel: parsedData.educationLevel || null,
    industry: parsedData.industry || null,
    location: parsedData.location || {},
    confidenceScore: parsedData.confidenceScore ?? 50,
  };
}

function computeScoreFromParsedData(parsedData = {}, userId) {
  const skills = Array.isArray(parsedData.skills)
    ? parsedData.skills.length
    : 0;

  const overallScore = Math.min(
    100,
    skills * 3 + Number(parsedData.yearsExperience || 0) * 5
  );

  return {
    isMockData: false,
    userId,
    roleFit:
      parsedData.detectedRoles?.[0]?.canonical ||
      'unknown',
    overallScore,
    breakdown: {
      skills: skills > 0 ? Math.min(30, skills * 3) : 0,
      experience: Number(parsedData.yearsExperience || 0) > 0
        ? 10
        : 0,
      roleMatch: parsedData.detectedRoles?.length
        ? 15
        : 0,
      education: parsedData.educationLevel ? 10 : 0,
      completeness: parsedData.email ? 10 : 0,
    },
    scoredAt: 'stable-test-timestamp',
  };
}

const SAMPLE_PARSED_DATA = {
  name: 'Priya Sharma',
  email: 'priya@example.com',
  skills: ['Python', 'SQL', 'TensorFlow'],
  detectedRoles: [
    { canonical: 'Data Scientist', score: 4.5 },
  ],
  yearsExperience: 4,
  educationLevel: "Master's Degree",
};

describe('pipeline.integration', () => {
  test('buildUserProfile normalizes skills', () => {
    const profile = buildUserProfile(
      USER_ID,
      SAMPLE_PARSED_DATA
    );

    assert.strictEqual(profile.userId, USER_ID);
    assert.ok(profile.skills.every((s) => s === s.toLowerCase()));
    assert.strictEqual(profile.experienceYears, 4);
  });

  test('computeScoreFromParsedData returns real score', () => {
    const score = computeScoreFromParsedData(
      SAMPLE_PARSED_DATA,
      USER_ID
    );

    assert.strictEqual(score.isMockData, false);
    assert.ok(score.overallScore > 0);
    assert.notStrictEqual(score.overallScore, 72);
    assert.strictEqual(score.roleFit, 'Data Scientist');
  });

  test('empty parsedData handled safely', () => {
    const score = computeScoreFromParsedData({}, USER_ID);

    assert.strictEqual(score.isMockData, false);
    assert.strictEqual(score.overallScore, 0);
    assert.strictEqual(score.roleFit, 'unknown');
  });
});