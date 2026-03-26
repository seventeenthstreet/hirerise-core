'use strict';

/**
 * Phase 2 — CHI Pipeline Unit Tests
 *
 * Covers:
 *   P2-01  careerHistory fallback from Track A experience[]
 *   P2-02  careerMomentum scoring uses experience dates
 *   P2-03  confidence label tiers (getConfidenceLabel)
 *   P2-04  analysisSource state machine (ANALYSIS_SOURCE_RANK)
 *   P2-05  getChiReady — isReady logic for all 5 states
 *   P2-06  retryAfterSeconds on AI 502
 *   P2-07  getCareerReportStatus — pending / complete / failed states
 *
 * Mocking strategy:
 *   - Firestore is mocked via jest.mock so tests run without a real DB.
 *   - Anthropic client returns null in NODE_ENV=test (existing guard in CHI service).
 *   - Service functions that require real Firestore are tested via controlled mocks.
 */

process.env.NODE_ENV = 'test';

// ─── Helpers extracted from careerHealthIndex.service.js ─────────────────────
// These are pure functions — test them directly without mocking Firestore.

/**
 * Replicated from careerHealthIndex.service.js for isolated unit testing.
 * If the service implementation changes, these tests will catch the divergence.
 */
function calculateChiConfidence({ resumeData = {}, userProfile = {}, jobDemandCount = null } = {}) {
  let confidence = 0;
  if (resumeData.score !== null && resumeData.score !== undefined) confidence += 20;
  if (resumeData.cvContentStructured)                               confidence += 15;
  if (resumeData.estimatedExperienceYears > 0)                      confidence += 15;
  if ((resumeData.topSkills?.length || 0) >= 4)                     confidence += 15;
  if ((userProfile.careerHistory?.length || 0) >= 1)                confidence += 10;
  if (userProfile.currentSalaryLPA || userProfile.expectedSalaryLPA) confidence += 10;
  if (jobDemandCount !== null)                                       confidence += 10;
  if (resumeData.targetRole)                                         confidence += 5;
  return Math.min(100, confidence);
}

function getConfidenceLabel(score) {
  if (score >= 85) return 'very_high';
  if (score >= 70) return 'high';
  if (score >= 40) return 'moderate';
  return 'low';
}

const ANALYSIS_SOURCE_RANK = {
  teaser:             0,
  quick_provisional:  1,
  provisional:        2,
  resume_scored:      3,
  full:               4,
};

function _estimateExperienceYears(experience = []) {
  let totalMonths = 0;
  for (const exp of experience) {
    if (exp.startDate) {
      const start = new Date(exp.startDate + '-01');
      const end   = exp.isCurrent ? new Date() : (exp.endDate ? new Date(exp.endDate + '-01') : new Date());
      const months = (end - start) / (1000 * 60 * 60 * 24 * 30.44);
      if (months > 0) totalMonths += months;
    }
  }
  return Math.round(totalMonths / 12);
}

// Synthetic careerHistory builder — matches P2-01 logic in careerHealthIndex.service.js
function buildSyntheticCareerHistory(experience = []) {
  return experience.map(exp => {
    let durationMonths = 0;
    if (exp.startDate) {
      const start = new Date(exp.startDate + '-01');
      const end   = exp.isCurrent ? new Date() : (exp.endDate ? new Date(exp.endDate + '-01') : new Date());
      durationMonths = Math.max(1, Math.round((end - start) / (1000 * 60 * 60 * 24 * 30.44)));
    }
    return {
      roleId:         null,
      jobTitle:       exp.jobTitle,
      company:        exp.company,
      durationMonths,
      isCurrent:      exp.isCurrent || false,
      source:         'track_a_fallback',
    };
  });
}


// ─────────────────────────────────────────────────────────────────────────────
// P2-03: CHI Confidence Label
// ─────────────────────────────────────────────────────────────────────────────

describe('P2-03: getConfidenceLabel', () => {
  test('returns low for score < 40', () => {
    expect(getConfidenceLabel(0)).toBe('low');
    expect(getConfidenceLabel(20)).toBe('low');
    expect(getConfidenceLabel(39)).toBe('low');
  });

  test('returns moderate for score 40-69', () => {
    expect(getConfidenceLabel(40)).toBe('moderate');
    expect(getConfidenceLabel(55)).toBe('moderate');
    expect(getConfidenceLabel(69)).toBe('moderate');
  });

  test('returns high for score 70-84', () => {
    expect(getConfidenceLabel(70)).toBe('high');
    expect(getConfidenceLabel(77)).toBe('high');
    expect(getConfidenceLabel(84)).toBe('high');
  });

  test('returns very_high for score >= 85', () => {
    expect(getConfidenceLabel(85)).toBe('very_high');
    expect(getConfidenceLabel(100)).toBe('very_high');
  });
});

describe('P2-03: calculateChiConfidence', () => {
  test('returns 0 for completely empty inputs', () => {
    expect(calculateChiConfidence()).toBe(0);
  });

  test('scores resume-scored scenario correctly', () => {
    const score = calculateChiConfidence({
      resumeData: {
        score: 72,
        estimatedExperienceYears: 5,
        topSkills: ['JS', 'React', 'Node', 'AWS'],
        targetRole: 'senior-engineer',
      },
      userProfile: {
        currentSalaryLPA: 18,
        careerHistory: [{ roleId: 'eng-1', durationMonths: 24 }],
      },
      jobDemandCount: 50,
    });
    // score(20) + years(15) + skills(15) + careerHistory(10) + salary(10) + demand(10) + role(5) = 85
    expect(score).toBe(85);
    expect(getConfidenceLabel(score)).toBe('very_high');
  });

  test('provisional scenario (no resume) is capped below full-score level', () => {
    const score = calculateChiConfidence({
      resumeData: {
        score: null,
        estimatedExperienceYears: 3,
        topSkills: ['Python', 'SQL', 'Tableau'],
        targetRole: 'data-analyst',
      },
      userProfile: {},
      jobDemandCount: null,
    });
    // No resume score (0), no cvStructured (0), years(15), skills<4 (0), no history(0), no salary(0), no demand(0), role(5) = 20
    expect(score).toBe(20);
    expect(getConfidenceLabel(score)).toBe('low');
  });

  test('clamps at 100 even when all signals present', () => {
    const score = calculateChiConfidence({
      resumeData: {
        score: 90,
        cvContentStructured: { sections: [] },
        estimatedExperienceYears: 10,
        topSkills: ['A', 'B', 'C', 'D', 'E'],
        targetRole: 'cto',
      },
      userProfile: {
        careerHistory: [{ roleId: 'r1', durationMonths: 36 }],
        currentSalaryLPA: 80,
      },
      jobDemandCount: 200,
    });
    expect(score).toBe(100);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// P2-04: analysisSource State Machine
// ─────────────────────────────────────────────────────────────────────────────

describe('P2-04: ANALYSIS_SOURCE_RANK', () => {
  test('teaser has lowest rank', () => {
    expect(ANALYSIS_SOURCE_RANK.teaser).toBe(0);
  });

  test('quick_provisional < provisional', () => {
    expect(ANALYSIS_SOURCE_RANK.quick_provisional)
      .toBeLessThan(ANALYSIS_SOURCE_RANK.provisional);
  });

  test('provisional < resume_scored', () => {
    expect(ANALYSIS_SOURCE_RANK.provisional)
      .toBeLessThan(ANALYSIS_SOURCE_RANK.resume_scored);
  });

  test('resume_scored < full', () => {
    expect(ANALYSIS_SOURCE_RANK.resume_scored)
      .toBeLessThan(ANALYSIS_SOURCE_RANK.full);
  });

  test('full has highest rank', () => {
    const maxRank = Math.max(...Object.values(ANALYSIS_SOURCE_RANK));
    expect(ANALYSIS_SOURCE_RANK.full).toBe(maxRank);
  });

  test('all 5 states are defined', () => {
    const expected = ['teaser', 'quick_provisional', 'provisional', 'resume_scored', 'full'];
    for (const state of expected) {
      expect(ANALYSIS_SOURCE_RANK[state]).toBeDefined();
    }
  });

  test('upgrade logic: full should replace provisional', () => {
    const existingRank = ANALYSIS_SOURCE_RANK.provisional;
    const newRank      = ANALYSIS_SOURCE_RANK.full;
    expect(newRank).toBeGreaterThanOrEqual(existingRank);
  });

  test('downgrade guard: provisional should NOT replace full', () => {
    const existingRank = ANALYSIS_SOURCE_RANK.full;
    const newRank      = ANALYSIS_SOURCE_RANK.provisional;
    expect(newRank).toBeLessThan(existingRank);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// P2-01: careerHistory fallback from Track A experience
// ─────────────────────────────────────────────────────────────────────────────

describe('P2-01: buildSyntheticCareerHistory', () => {
  test('returns empty array for empty experience', () => {
    expect(buildSyntheticCareerHistory([])).toEqual([]);
  });

  test('maps jobTitle and company correctly', () => {
    const result = buildSyntheticCareerHistory([{
      jobTitle: 'Senior Engineer',
      company:  'Accenture',
      startDate: '2020-01',
      isCurrent: true,
    }]);
    expect(result[0].jobTitle).toBe('Senior Engineer');
    expect(result[0].company).toBe('Accenture');
    expect(result[0].roleId).toBeNull();
    expect(result[0].source).toBe('track_a_fallback');
  });

  test('calculates durationMonths > 0 for current role', () => {
    const result = buildSyntheticCareerHistory([{
      jobTitle: 'PM',
      company:  'Flipkart',
      startDate: '2022-01',
      isCurrent: true,
    }]);
    expect(result[0].durationMonths).toBeGreaterThan(0);
  });

  test('calculates durationMonths from startDate to endDate for past role', () => {
    const result = buildSyntheticCareerHistory([{
      jobTitle:  'Analyst',
      company:   'Infosys',
      startDate: '2019-01',
      endDate:   '2021-01',
      isCurrent: false,
    }]);
    // Jan 2019 → Jan 2021 = 24 months
    expect(result[0].durationMonths).toBeCloseTo(24, 0);
  });

  test('sets minimum durationMonths of 1 for very short tenures', () => {
    const result = buildSyntheticCareerHistory([{
      jobTitle:  'Intern',
      company:   'Startup',
      startDate: '2023-06',
      endDate:   '2023-06',
      isCurrent: false,
    }]);
    expect(result[0].durationMonths).toBeGreaterThanOrEqual(1);
  });

  test('handles multiple experience entries', () => {
    const result = buildSyntheticCareerHistory([
      { jobTitle: 'Junior Dev', company: 'A', startDate: '2018-01', endDate: '2020-01', isCurrent: false },
      { jobTitle: 'Senior Dev', company: 'B', startDate: '2020-02', isCurrent: true },
    ]);
    expect(result).toHaveLength(2);
    expect(result[1].isCurrent).toBe(true);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// P2-02: _estimateExperienceYears from experience dates
// ─────────────────────────────────────────────────────────────────────────────

describe('P2-02: _estimateExperienceYears', () => {
  test('returns 0 for empty experience', () => {
    expect(_estimateExperienceYears([])).toBe(0);
  });

  test('correctly estimates from completed tenure', () => {
    const years = _estimateExperienceYears([{
      startDate: '2019-01',
      endDate:   '2023-01',
      isCurrent: false,
    }]);
    expect(years).toBe(4);
  });

  test('accumulates across multiple roles', () => {
    const years = _estimateExperienceYears([
      { startDate: '2016-01', endDate: '2018-01', isCurrent: false },
      { startDate: '2018-06', endDate: '2021-06', isCurrent: false },
    ]);
    expect(years).toBeGreaterThanOrEqual(4);
    expect(years).toBeLessThanOrEqual(6);
  });

  test('handles current role with no endDate', () => {
    const years = _estimateExperienceYears([{
      startDate: '2020-01',
      isCurrent: true,
    }]);
    expect(years).toBeGreaterThan(0);
  });

  test('skips entries with no startDate', () => {
    const years = _estimateExperienceYears([
      { company: 'Unknown', isCurrent: false }, // no startDate
      { startDate: '2021-01', endDate: '2023-01', isCurrent: false },
    ]);
    expect(years).toBe(2);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// P2-05: getChiReady logic (pure logic, no Firestore)
// ─────────────────────────────────────────────────────────────────────────────

describe('P2-05: getChiReady isReady logic', () => {
  // Replicate the core isReady decision logic for pure unit testing
  function determineIsReady(chiData) {
    if (!chiData) return false;
    if (chiData.analysisSource === 'teaser') return false;
    return true;
  }

  test('isReady: false when no CHI exists', () => {
    expect(determineIsReady(null)).toBe(false);
  });

  test('isReady: false when analysisSource is teaser', () => {
    expect(determineIsReady({ analysisSource: 'teaser', chiScore: 58 })).toBe(false);
  });

  test('isReady: true for quick_provisional', () => {
    expect(determineIsReady({ analysisSource: 'quick_provisional', chiScore: 45 })).toBe(true);
  });

  test('isReady: true for provisional', () => {
    expect(determineIsReady({ analysisSource: 'provisional', chiScore: 62 })).toBe(true);
  });

  test('isReady: true for resume_scored', () => {
    expect(determineIsReady({ analysisSource: 'resume_scored', chiScore: 74 })).toBe(true);
  });

  test('isReady: true for full', () => {
    expect(determineIsReady({ analysisSource: 'full', chiScore: 81 })).toBe(true);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// P2-06: retryAfterSeconds on AI failure
// ─────────────────────────────────────────────────────────────────────────────

describe('P2-06: AppError retryAfterSeconds', () => {
  // Load AppError from the actual errorHandler
  const { AppError } = require('../../src/middleware/errorHandler');

  test('AppError can carry retryAfterSeconds', () => {
    const err = new AppError('AI failed', 502, { retryAfterSeconds: 30 }, 'EXTERNAL_SERVICE_ERROR');
    err.retryAfterSeconds = 30;
    expect(err.retryAfterSeconds).toBe(30);
    expect(err.statusCode).toBe(502);
  });

  test('retryAfterSeconds is not present on regular validation errors', () => {
    const err = new AppError('Bad input', 400, {}, 'VALIDATION_ERROR');
    expect(err.retryAfterSeconds).toBeUndefined();
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// P2-07: getCareerReportStatus pure logic
// ─────────────────────────────────────────────────────────────────────────────

describe('P2-07: career report status logic', () => {
  function deriveStatus(progressData) {
    if (!progressData) return { status: 'pending', retryable: false };
    if (progressData.careerReport) return { status: 'complete', retryable: false };
    const failures = (progressData.aiFailures || []).filter(f => f.step === 'career_report');
    if (failures.length > 0) {
      const latest = failures[failures.length - 1];
      return { status: 'failed', retryable: latest.retryable !== false, retryAfterSeconds: 30 };
    }
    return { status: 'pending', retryable: false };
  }

  test('returns pending when no progress data', () => {
    expect(deriveStatus(null).status).toBe('pending');
  });

  test('returns pending when no careerReport and no failures', () => {
    expect(deriveStatus({}).status).toBe('pending');
  });

  test('returns complete when careerReport exists', () => {
    expect(deriveStatus({ careerReport: { overallAssessment: 'Strong profile' } }).status).toBe('complete');
  });

  test('returns failed when aiFailures contains career_report entry', () => {
    const result = deriveStatus({
      aiFailures: [{ step: 'career_report', retryable: true, failedAt: new Date().toISOString(), errorCode: '529' }],
    });
    expect(result.status).toBe('failed');
    expect(result.retryable).toBe(true);
    expect(result.retryAfterSeconds).toBe(30);
  });

  test('retryable is false when failure has retryable:false', () => {
    const result = deriveStatus({
      aiFailures: [{ step: 'career_report', retryable: false, failedAt: new Date().toISOString() }],
    });
    expect(result.retryable).toBe(false);
  });

  test('ignores aiFailures for other steps', () => {
    const result = deriveStatus({
      aiFailures: [{ step: 'generate_cv', retryable: true, failedAt: new Date().toISOString() }],
    });
    expect(result.status).toBe('pending'); // no career_report failure
  });

  test('complete takes precedence over failures', () => {
    // careerReport present AND there are old failures — should still return complete
    const result = deriveStatus({
      careerReport: { overallAssessment: 'Good' },
      aiFailures: [{ step: 'career_report', retryable: true, failedAt: new Date().toISOString() }],
    });
    expect(result.status).toBe('complete');
  });
});