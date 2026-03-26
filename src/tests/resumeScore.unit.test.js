'use strict';

/**
 * resumeScore.unit.test.js
 *
 * Tests the pure scoring functions in resumeScore.service.js.
 * No DB, no Redis, no external I/O — safe to run in any environment.
 *
 * Run: NODE_ENV=test node --test resumeScore.unit.test.js
 * Or:  NODE_ENV=test npx jest resumeScore.unit.test.js
 */

const assert = require('assert');

// ── Import only the pure functions exported for testing ───────────────────────
const {
  computeScoreFromParsedData,
  _scorers: {
    scoreSkills,
    scoreExperience,
    scoreRoleMatch,
    scoreEducation,
    scoreCompleteness,
  },
} = require('./resumeScore.service');

// ─────────────────────────────────────────────────────────────────────────────
// HELPER
// ─────────────────────────────────────────────────────────────────────────────
function makeParsedData(overrides = {}) {
  return {
    name:            'Jane Doe',
    email:           'jane@example.com',
    phone:           '+91 9876543210',
    location:        { city: 'Bengaluru', country: 'India' },
    linkedInUrl:     'https://linkedin.com/in/janedoe',
    portfolioUrl:    null,
    skills:          ['JavaScript', 'React', 'Node.js', 'SQL', 'Git', 'REST APIs'],
    detectedRoles:   [{ canonical: 'Software Engineer', score: 4 }],
    yearsExperience: 5,
    education:       ["Bachelor's Degree in Computer Science"],
    educationLevel:  "Bachelor's Degree",
    confidenceScore: 78,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// scoreSkills
// ─────────────────────────────────────────────────────────────────────────────
{
  // Empty/missing → 0
  assert.strictEqual(scoreSkills([]), 0, 'empty skills array should score 0');
  assert.strictEqual(scoreSkills(null), 0, 'null skills should score 0');
  assert.strictEqual(scoreSkills(undefined), 0, 'undefined skills should score 0');

  // Single skill → small positive score
  const single = scoreSkills(['JavaScript']);
  assert.ok(single > 0 && single <= 30, `single skill score ${single} should be 1–30`);

  // More skills → higher score (monotonic up to ceiling)
  const ten   = scoreSkills(Array.from({ length: 10 }, (_, i) => `Skill${i}`));
  const twenty = scoreSkills(Array.from({ length: 20 }, (_, i) => `Skill${i}`));
  const forty  = scoreSkills(Array.from({ length: 40 }, (_, i) => `Skill${i}`));
  assert.ok(ten < twenty, `10 skills (${ten}) should score less than 20 (${twenty})`);
  assert.ok(twenty < forty, `20 skills (${twenty}) should score less than 40 (${forty})`);

  // 40+ skills → max (30)
  const tooMany = scoreSkills(Array.from({ length: 100 }, (_, i) => `Skill${i}`));
  assert.strictEqual(tooMany, 30, '100 skills should hit the 30-pt ceiling');

  // Duplicates are deduplicated
  const dupes = scoreSkills(['React', 'React', 'react', 'REACT']);
  const unique = scoreSkills(['React']);
  assert.strictEqual(dupes, unique, 'duplicate skills should not inflate score');

  console.log('✓ scoreSkills — all assertions passed');
}

// ─────────────────────────────────────────────────────────────────────────────
// scoreExperience
// ─────────────────────────────────────────────────────────────────────────────
{
  assert.strictEqual(scoreExperience(null), 0, 'null years → 0');
  assert.strictEqual(scoreExperience(undefined), 0, 'undefined years → 0');
  assert.strictEqual(scoreExperience(0), 0, '0 years → 0');

  // Senior (7 yrs) → full score (25)
  assert.strictEqual(scoreExperience(7), 25, '7 years should give full score 25');
  assert.strictEqual(scoreExperience(10), 25, '10 years should give full score 25');
  assert.strictEqual(scoreExperience(20), 25, '20 years should give full score 25');

  // Progression is monotonic
  const y1 = scoreExperience(1);
  const y3 = scoreExperience(3);
  const y5 = scoreExperience(5);
  const y7 = scoreExperience(7);
  assert.ok(y1 < y3 && y3 < y5 && y5 <= y7,
    `Scores should increase with experience: ${y1} < ${y3} < ${y5} <= ${y7}`);

  console.log('✓ scoreExperience — all assertions passed');
}

// ─────────────────────────────────────────────────────────────────────────────
// scoreRoleMatch
// ─────────────────────────────────────────────────────────────────────────────
{
  // No roles, no confidence → low score
  const noRole = scoreRoleMatch([], 0);
  assert.strictEqual(noRole, 0, 'no roles, 0 confidence → 0');

  // No roles, high confidence → partial score
  const highConf = scoreRoleMatch([], 100);
  assert.ok(highConf > 0 && highConf < 20,
    `no roles, 100% confidence → partial score, got ${highConf}`);

  // Object role with score
  const objRole = scoreRoleMatch([{ canonical: 'Engineer', score: 5 }], 80);
  assert.ok(objRole > highConf, `object role with score should beat no-role: ${objRole} > ${highConf}`);

  // String role (legacy format)
  const strRole = scoreRoleMatch(['Software Engineer'], 60);
  assert.ok(strRole > 0, `string role should produce a positive score, got ${strRole}`);

  // Max score is bounded
  const maxScore = scoreRoleMatch([{ canonical: 'Engineer', score: 10 }], 100);
  assert.ok(maxScore <= 20, `role match score must not exceed 20, got ${maxScore}`);

  console.log('✓ scoreRoleMatch — all assertions passed');
}

// ─────────────────────────────────────────────────────────────────────────────
// scoreEducation
// ─────────────────────────────────────────────────────────────────────────────
{
  assert.strictEqual(scoreEducation([], null), 0, 'no education → 0');
  assert.strictEqual(scoreEducation(null, null), 0, 'null inputs → 0');

  // Structured educationLevel field
  const hsScore  = scoreEducation([], 'High School');
  const bsScore  = scoreEducation([], "Bachelor's Degree");
  const msScore  = scoreEducation([], "Master's Degree");
  const phdScore = scoreEducation([], 'PhD');

  assert.ok(hsScore < bsScore, `HS (${hsScore}) < BS (${bsScore})`);
  assert.ok(bsScore < msScore, `BS (${bsScore}) < MS (${msScore})`);
  assert.ok(msScore <= phdScore, `MS (${msScore}) <= PhD (${phdScore})`);
  assert.strictEqual(phdScore, 15, `PhD should give max 15 pts, got ${phdScore}`);

  // Fallback: detect from raw education array
  const fromArray = scoreEducation(["Bachelor's Degree in Engineering"], null);
  assert.ok(fromArray > 0, `should detect degree from array, got ${fromArray}`);

  console.log('✓ scoreEducation — all assertions passed');
}

// ─────────────────────────────────────────────────────────────────────────────
// scoreCompleteness
// ─────────────────────────────────────────────────────────────────────────────
{
  // All fields present → max (10)
  const full = scoreCompleteness({
    name:        'Jane Doe',
    email:       'jane@example.com',
    phone:       '+91 9876543210',
    location:    { city: 'Bengaluru' },
    linkedInUrl: 'https://linkedin.com/in/janedoe',
  });
  assert.strictEqual(full, 10, `all fields present → 10, got ${full}`);

  // No fields → 0
  const empty = scoreCompleteness({});
  assert.strictEqual(empty, 0, 'empty object → 0');

  // Partial: name + email only → 4
  const partial = scoreCompleteness({ name: 'Jane', email: 'jane@example.com' });
  assert.strictEqual(partial, 4, `name + email → 4, got ${partial}`);

  // Location as plain string (some parsers return this)
  const strLoc = scoreCompleteness({
    name:     'Jane',
    email:    'jane@example.com',
    phone:    '999',
    location: 'Bengaluru, India',
  });
  assert.ok(strLoc > partial, `string location should be counted, got ${strLoc}`);

  console.log('✓ scoreCompleteness — all assertions passed');
}

// ─────────────────────────────────────────────────────────────────────────────
// computeScoreFromParsedData — integration of all scorers
// ─────────────────────────────────────────────────────────────────────────────
{
  const parsed = makeParsedData();
  const result = computeScoreFromParsedData(parsed, 'user_123');

  // Shape
  assert.ok(result, 'result must be truthy');
  assert.strictEqual(result.isMockData, false, 'isMockData must be false');
  assert.strictEqual(result.userId, 'user_123', 'userId must be passed through');
  assert.ok(typeof result.overallScore === 'number', 'overallScore must be a number');
  assert.ok(result.overallScore >= 0 && result.overallScore <= 100,
    `overallScore must be 0–100, got ${result.overallScore}`);
  assert.ok(result.breakdown, 'breakdown must be present');
  assert.ok(result.roleFit, 'roleFit must be present');
  assert.ok(result.scoredAt, 'scoredAt must be present');
  assert.ok(result._meta, '_meta must be present');

  // Breakdown dimensions
  const dims = ['skills', 'experience', 'roleMatch', 'education', 'completeness'];
  for (const dim of dims) {
    assert.ok(typeof result.breakdown[dim] === 'number',
      `breakdown.${dim} must be a number, got ${typeof result.breakdown[dim]}`);
    assert.ok(result.breakdown[dim] >= 0,
      `breakdown.${dim} must be >= 0, got ${result.breakdown[dim]}`);
  }

  // Breakdown sum equals overallScore (before min(100) clamp)
  const sum = dims.reduce((s, d) => s + result.breakdown[d], 0);
  assert.strictEqual(result.overallScore, Math.min(100, sum),
    `overallScore (${result.overallScore}) must equal min(100, sum of breakdown (${sum}))`);

  // roleFit extracted from detectedRoles[0].canonical
  assert.strictEqual(result.roleFit, 'Software Engineer',
    `roleFit should be 'Software Engineer', got '${result.roleFit}'`);

  // A well-formed resume should score > 50
  assert.ok(result.overallScore > 50,
    `a well-formed mid-level resume should score > 50, got ${result.overallScore}`);

  console.log(`✓ computeScoreFromParsedData — overallScore: ${result.overallScore}/100`);
  console.log('  Breakdown:', JSON.stringify(result.breakdown));
}

// ─────────────────────────────────────────────────────────────────────────────
// Edge cases — minimal resume, graceful handling
// ─────────────────────────────────────────────────────────────────────────────
{
  // Completely empty parsedData should not throw
  const empty = computeScoreFromParsedData({}, 'user_empty');
  assert.strictEqual(empty.isMockData, false, 'empty parsedData → isMockData: false');
  assert.strictEqual(empty.overallScore, 0, `empty parsedData → score 0, got ${empty.overallScore}`);
  assert.strictEqual(empty.roleFit, 'unknown', `no roles → roleFit 'unknown'`);

  // String detectedRoles (legacy format — some old documents stored plain strings)
  const legacy = computeScoreFromParsedData(
    { ...makeParsedData(), detectedRoles: ['Data Analyst', 'Business Analyst'] },
    'user_legacy'
  );
  assert.ok(legacy.roleFit === 'Data Analyst',
    `string detectedRoles[0] → roleFit 'Data Analyst', got '${legacy.roleFit}'`);

  // Negative years should not throw or produce negative scores
  const negYears = computeScoreFromParsedData(
    { ...makeParsedData(), yearsExperience: -5 },
    'user_neg'
  );
  assert.ok(negYears.breakdown.experience >= 0,
    `negative years → experience score >= 0, got ${negYears.breakdown.experience}`);

  // Very high confidence with no skills → completeness and roleMatch still sensible
  const noSkills = computeScoreFromParsedData(
    { ...makeParsedData(), skills: [], confidenceScore: 95 },
    'user_noskills'
  );
  assert.strictEqual(noSkills.breakdown.skills, 0, 'no skills → skills score 0');
  assert.ok(noSkills.breakdown.roleMatch > 0, 'high confidence → positive roleMatch');

  console.log('✓ Edge cases — all handled without throwing');
}

// ─────────────────────────────────────────────────────────────────────────────
// Verify isMockData is NEVER true
// ─────────────────────────────────────────────────────────────────────────────
{
  const variations = [
    makeParsedData(),
    {},
    makeParsedData({ skills: [], detectedRoles: [] }),
    makeParsedData({ yearsExperience: 0 }),
    makeParsedData({ educationLevel: 'PhD', yearsExperience: 20 }),
  ];

  for (const v of variations) {
    const r = computeScoreFromParsedData(v, 'user_test');
    assert.strictEqual(r.isMockData, false,
      `isMockData must always be false, but was ${r.isMockData} for input: ${JSON.stringify(v).slice(0, 80)}`);
  }
  console.log('✓ isMockData is false for all input variations');
}

console.log('\n✅ All resumeScore.service tests passed');








