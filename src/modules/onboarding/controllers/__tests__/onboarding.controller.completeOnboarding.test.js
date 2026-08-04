'use strict';

/**
 * src/modules/onboarding/controllers/__tests__/onboarding.controller.completeOnboarding.test.js
 *
 * WP-PRO-11 Part 5 — completeOnboarding() previously always responded with
 * `step: 'complete'`, even when persistCompletionIfReady() performed no
 * persistence because completion criteria were not met. It now returns the
 * real completion outcome reported by persistCompletionIfReady() (see
 * onboarding.helpers.js's WP-PRO-11 return-value contract).
 *
 * Every other controller export in this file has its own existing coverage
 * (or none) untouched by this WP; this file only exercises completeOnboarding.
 */

const mockSupabaseFrom = jest.fn();

jest.mock('../../../../config/supabase', () => ({
  supabase: { from: (...args) => mockSupabaseFrom(...args) },
}));

jest.mock('../../../../utils/logger', () => ({
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const mockMergeStepHistory        = jest.fn();
const mockPersistCompletionIfReady = jest.fn();

jest.mock('../../onboarding.service', () => ({
  mergeStepHistory:         (...args) => mockMergeStepHistory(...args),
  persistCompletionIfReady: (...args) => mockPersistCompletionIfReady(...args),
}));

// Everything else the controller module imports at load time — irrelevant
// to completeOnboarding(), stubbed out only so `require('../onboarding.
// controller')` doesn't throw.
jest.mock('../../../resume/resume.service', () => ({ uploadResume: jest.fn() }));
jest.mock('../../../../services/resumeParser', () => ({
  parseResumeText:            jest.fn(),
  mapParsedToOnboardingShape: jest.fn(),
}));
jest.mock('../../../../services/resumeParser/resume.normalizer', () => ({
  normalizeFromOnboardingShape: jest.fn(),
  toFrontendShape:              jest.fn(),
}));
jest.mock('../../../../domain/professionalProfile/professionalProfile.normalizer', () => ({
  normalizeResumeUpload: jest.fn(),
}));
jest.mock('../../../../domain/professionalProfile/professionalProfile.repository', () => ({
  saveProfessionalProfileSections: jest.fn(),
  getProfessionalProfile:          jest.fn(),
}));
jest.mock('../../../../domain/professionalProfile/professionalProfile.schema', () => ({
  ACQUISITION_METHODS: {},
}));
jest.mock('../../../../services/resumeParser/aiExtractor.service', () => ({
  isWeakParse:         jest.fn(),
  extractWithAI:       jest.fn(),
  mergeAIWithStructured: jest.fn(),
}));
jest.mock('../../../../services/confidence.service', () => ({ computeConfidence: jest.fn() }));
jest.mock('../../../../services/quality.service',    () => ({ computeQuality: jest.fn() }));
jest.mock('../../../../lib/db/authoritativeMutation', () => ({ authoritativeUpsert: jest.fn() }));

const { completeOnboarding } = require('../onboarding.controller');

function makeRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json   = jest.fn(() => res);
  return res;
}

function makeSelectMaybeSingleChain(row) {
  return {
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: row, error: null }),
      }),
    }),
  };
}

const USER_ID = 'user-1';

describe('onboarding.controller#completeOnboarding — WP-PRO-11 Part 5', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMergeStepHistory.mockResolvedValue(['complete']);
    mockSupabaseFrom.mockImplementation((table) => {
      if (table === 'onboarding_progress') return makeSelectMaybeSingleChain({ id: USER_ID });
      if (table === 'user_profiles')       return makeSelectMaybeSingleChain({ id: USER_ID });
      throw new Error(`unexpected table in test: ${table}`);
    });
  });

  it("responds step: 'complete' and isComplete: true when persistCompletionIfReady reports completion", async () => {
    mockPersistCompletionIfReady.mockResolvedValue({
      isComplete: true, alreadyCompleted: false, trackA: false, trackAUpload: false, trackB: true,
    });

    const req = { user: { id: USER_ID }, requestId: 'req-1', originalUrl: '/api/v1/onboarding/complete' };
    const res = makeRes();
    const next = jest.fn();

    await completeOnboarding(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        step:       'complete',
        isComplete: true,
        completion: { isComplete: true, alreadyCompleted: false, trackA: false, trackAUpload: false, trackB: true },
        stepHistory: ['complete'],
      },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("responds step: 'incomplete' and isComplete: false — no longer fabricates completion — when criteria are not met", async () => {
    mockPersistCompletionIfReady.mockResolvedValue({
      isComplete: false, alreadyCompleted: false, trackA: false, trackAUpload: false, trackB: false,
    });

    const req = { user: { id: USER_ID }, requestId: 'req-2', originalUrl: '/api/v1/onboarding/complete' };
    const res = makeRes();
    const next = jest.fn();

    await completeOnboarding(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    const [[payload]] = res.json.mock.calls;
    expect(payload.data.step).toBe('incomplete');
    expect(payload.data.isComplete).toBe(false);
    expect(payload.data.completion).toEqual({
      isComplete: false, alreadyCompleted: false, trackA: false, trackAUpload: false, trackB: false,
    });
  });

  it("responds step: 'complete' when onboarding was already completed on a prior call (idempotent retry)", async () => {
    mockPersistCompletionIfReady.mockResolvedValue({ isComplete: true, alreadyCompleted: true });

    const req = { user: { id: USER_ID }, requestId: 'req-3', originalUrl: '/api/v1/onboarding/complete' };
    const res = makeRes();
    const next = jest.fn();

    await completeOnboarding(req, res, next);

    const [[payload]] = res.json.mock.calls;
    expect(payload.data.step).toBe('complete');
    expect(payload.data.isComplete).toBe(true);
    expect(payload.data.completion.alreadyCompleted).toBe(true);
  });

  it('propagates errors from persistCompletionIfReady via next() rather than responding 200', async () => {
    const err = new Error('db unavailable');
    mockPersistCompletionIfReady.mockRejectedValue(err);

    const req = { user: { id: USER_ID }, requestId: 'req-4', originalUrl: '/api/v1/onboarding/complete' };
    const res = makeRes();
    const next = jest.fn();

    await completeOnboarding(req, res, next);

    expect(res.json).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(err);
  });

  it('returns 401 UNAUTHORIZED without calling persistCompletionIfReady when there is no authenticated user', async () => {
    const req = { requestId: 'req-5', originalUrl: '/api/v1/onboarding/complete' };
    const res = makeRes();
    const next = jest.fn();

    await completeOnboarding(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockPersistCompletionIfReady).not.toHaveBeenCalled();
  });
});
