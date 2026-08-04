'use strict';

/**
 * src/modules/onboarding/__tests__/completeOnboarding.wp-pro-12a-2.test.js
 *
 * WP-PRO-12A-2 — Completion Backend Contract Restoration.
 *
 * Controller-level tests for `completeOnboarding()`. These exercise the
 * restored contract end-to-end at the controller boundary:
 *   POST /api/v1/onboarding/complete
 *     -> completeOnboarding()
 *     -> persistCompletionIfReady()   (mocked here — its own behaviour is
 *                                      covered by onboarding.helpers
 *                                      .completionSync.test.js and
 *                                      evaluateCompletion.wp-pro-10g.test.js)
 *     -> HTTP response
 *
 * `evaluateCompletion()` itself is not exercised here — these tests only
 * verify that the controller correctly consumes whatever structured result
 * persistCompletionIfReady() returns and shapes the declared
 * `CompleteOnboardingResponse` contract from it.
 */

jest.mock('../onboarding.service', () => ({
  mergeStepHistory: jest.fn(),
  persistCompletionIfReady: jest.fn(),
}));

jest.mock('../../../config/supabase', () => ({
  supabase: { from: jest.fn() },
}));

jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// The controller module also pulls in a wide surface of other onboarding
// collaborators (resume parsing, Professional Profile normalisation, AI
// extraction, etc.) that completeOnboarding() itself never touches. They're
// stubbed out here purely so requiring the controller module doesn't need
// their real (heavier) dependency graphs.
jest.mock('../../resume/resume.service', () => ({ uploadResume: jest.fn() }));
jest.mock('../../../services/resumeParser', () => ({
  parseResumeText: jest.fn(),
  mapParsedToOnboardingShape: jest.fn(),
}));
jest.mock('../../../services/resumeParser/resume.normalizer', () => ({
  normalizeFromOnboardingShape: jest.fn(),
  toFrontendShape: jest.fn(),
}));
jest.mock('../../../domain/professionalProfile/professionalProfile.normalizer', () => ({
  normalizeResumeUpload: jest.fn(),
}));
jest.mock('../../../domain/professionalProfile/professionalProfile.repository', () => ({
  saveProfessionalProfileSections: jest.fn(),
  getProfessionalProfile: jest.fn(),
}));
jest.mock('../../../domain/professionalProfile/professionalProfile.schema', () => ({
  ACQUISITION_METHODS: {},
}));
jest.mock('../../../services/resumeParser/aiExtractor.service', () => ({
  isWeakParse: jest.fn(),
  extractWithAI: jest.fn(),
  mergeAIWithStructured: jest.fn(),
}));
jest.mock('../../../services/confidence.service', () => ({ computeConfidence: jest.fn() }));
jest.mock('../../../services/quality.service', () => ({ computeQuality: jest.fn() }));
jest.mock('../../../lib/db/authoritativeMutation', () => ({ authoritativeUpsert: jest.fn() }));

const { mergeStepHistory, persistCompletionIfReady } = require('../onboarding.service');
const { supabase } = require('../../../config/supabase');
const { completeOnboarding } = require('../controllers/onboarding.controller');

const USER_ID = 'user-1';

function makeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function makeReq() {
  return {
    user: { id: USER_ID },
    requestId: 'req-1',
    originalUrl: '/api/v1/onboarding/complete',
  };
}

function mockRowSelects({ progressRow = {}, profileRow = {} } = {}) {
  supabase.from.mockImplementation((table) => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => {
          if (table === 'onboarding_progress') return { data: progressRow, error: null };
          if (table === 'user_profiles') return { data: profileRow, error: null };
          return { data: null, error: null };
        },
      }),
    }),
  }));
}

describe('completeOnboarding controller — WP-PRO-12A-2 contract restoration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mergeStepHistory.mockResolvedValue(['step-a', 'complete']);
    mockRowSelects();
  });

  it('returns the canonical idempotent contract when onboarding is already completed', async () => {
    persistCompletionIfReady.mockResolvedValue({
      isComplete: true,
      alreadyCompleted: true,
      trackA: true,
      trackAUpload: false,
      trackB: false,
    });

    const req = makeReq();
    const res = makeRes();

    await completeOnboarding(req, res, jest.fn());

    expect(persistCompletionIfReady).toHaveBeenCalledWith(USER_ID, {}, {});
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        step: 'complete',
        isComplete: true,
        completion: {
          isComplete: true,
          trackA: true,
          trackAUpload: false,
          trackB: false,
          alreadyCompleted: true,
        },
        stepHistory: ['step-a', 'complete'],
      },
    });
  });

  it('returns the canonical contract when onboarding is newly completed by this request', async () => {
    persistCompletionIfReady.mockResolvedValue({
      isComplete: true,
      alreadyCompleted: false,
      trackA: false,
      trackAUpload: true,
      trackB: false,
    });

    const req = makeReq();
    const res = makeRes();

    await completeOnboarding(req, res, jest.fn());

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        step: 'complete',
        isComplete: true,
        completion: {
          isComplete: true,
          trackA: false,
          trackAUpload: true,
          trackB: false,
          alreadyCompleted: false,
        },
        stepHistory: ['step-a', 'complete'],
      },
    });
  });

  it('returns isComplete: false with completion metadata when onboarding is not yet complete', async () => {
    persistCompletionIfReady.mockResolvedValue({
      isComplete: false,
      alreadyCompleted: false,
      trackA: false,
      trackAUpload: false,
      trackB: false,
    });

    const req = makeReq();
    const res = makeRes();

    await completeOnboarding(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        step: 'incomplete',
        isComplete: false,
        completion: {
          isComplete: false,
          trackA: false,
          trackAUpload: false,
          trackB: false,
          alreadyCompleted: false,
        },
        stepHistory: ['step-a', 'complete'],
      },
    });
  });

  it('propagates persistence failures unchanged (no response sent, error forwarded to next())', async () => {
    const dbError = new Error('Failed to persist onboarding completion');
    persistCompletionIfReady.mockRejectedValue(dbError);

    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    // completeOnboarding is wrapped by withAuth, which routes thrown errors
    // to next(err) rather than rejecting — this is the existing, unchanged
    // error-handling mechanism (see withAuth in onboarding.controller.js).
    await completeOnboarding(req, res, next);

    expect(next).toHaveBeenCalledWith(dbError);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('returns 401 and never calls persistCompletionIfReady for an unauthenticated request', async () => {
    const req = { user: null, requestId: 'req-2', originalUrl: '/api/v1/onboarding/complete' };
    const res = makeRes();
    const next = jest.fn();

    await completeOnboarding(req, res, next);

    expect(persistCompletionIfReady).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      data: { mode: 'sync' },
      error: { code: 'UNAUTHORIZED', message: 'Authentication required.' },
    });
  });
});
