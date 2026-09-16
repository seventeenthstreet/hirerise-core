'use strict';

/**
 * modules/student-onboarding/__tests__/recommendation-lifecycle.service.test.js
 *
 * Focus: the backend-owned aspiration → processing transition and the
 * isolation contract around generation kickoff (Phase 1 lifecycle spec).
 */

jest.mock('../services/session.service');
jest.mock('../services/recommendation-engine');

const sessionService = require('../services/session.service');
const recommendationEngine = require('../services/recommendation-engine');
const { initiateProcessingTransition } = require('../services/recommendation-lifecycle.service');

describe('recommendation-lifecycle.service', () => {
  afterEach(() => jest.clearAllMocks());

  it('advances the session past aspiration to processing', async () => {
    sessionService.getSession.mockResolvedValue({
      current_step: 'aspiration',
      completed_steps: ['education', 'academics', 'activities', 'cognitive'],
    });
    sessionService.updateProgression.mockResolvedValue({
      current_step: 'processing',
      completed_steps: ['education', 'academics', 'activities', 'cognitive', 'aspiration'],
      completion_pct: 100,
      is_complete: false,
    });
    recommendationEngine.initiateGeneration.mockResolvedValue({ started: true });

    const result = await initiateProcessingTransition('user-1');

    expect(sessionService.getSession).toHaveBeenCalledWith('user-1');
    expect(sessionService.updateProgression).toHaveBeenCalledWith('user-1', {
      completedStep: 'aspiration',
      nextStep: 'processing',
      completedSteps: ['education', 'academics', 'activities', 'cognitive', 'aspiration'],
    });
    expect(result.session.current_step).toBe('processing');
  });

  it('does not duplicate "aspiration" in completed_steps on a resubmission', async () => {
    sessionService.getSession.mockResolvedValue({
      current_step: 'aspiration',
      // 'aspiration' already recorded from a prior successful call.
      completed_steps: ['education', 'academics', 'activities', 'cognitive', 'aspiration'],
    });
    sessionService.updateProgression.mockResolvedValue({
      current_step: 'processing',
      completed_steps: ['education', 'academics', 'activities', 'cognitive', 'aspiration'],
      completion_pct: 100,
      is_complete: false,
    });
    recommendationEngine.initiateGeneration.mockResolvedValue({ started: false });

    await initiateProcessingTransition('user-1');

    expect(sessionService.updateProgression).toHaveBeenCalledWith('user-1', {
      completedStep: 'aspiration',
      nextStep: 'processing',
      completedSteps: ['education', 'academics', 'activities', 'cognitive', 'aspiration'],
    });
  });

  it('starts generation via the guarded initiateGeneration entry point, never generateRecommendations directly', async () => {
    sessionService.getSession.mockResolvedValue({ current_step: 'aspiration', completed_steps: [] });
    sessionService.updateProgression.mockResolvedValue({ current_step: 'processing', completed_steps: ['aspiration'] });
    recommendationEngine.initiateGeneration.mockResolvedValue({ started: true });

    await initiateProcessingTransition('user-1');

    expect(recommendationEngine.initiateGeneration).toHaveBeenCalledWith('user-1');
    expect(recommendationEngine.generateRecommendations).not.toHaveBeenCalled();
  });

  it('propagates a session-advance failure to the caller (fails onboarding completion)', async () => {
    sessionService.getSession.mockResolvedValue({ current_step: 'aspiration', completed_steps: [] });
    const err = new Error('session update failed');
    sessionService.updateProgression.mockRejectedValue(err);

    await expect(initiateProcessingTransition('user-1')).rejects.toThrow('session update failed');

    // Generation must never be started if the authoritative session
    // transition itself did not succeed.
    expect(recommendationEngine.initiateGeneration).not.toHaveBeenCalled();
  });

  it('isolates a generation-kickoff failure: does not fail onboarding completion', async () => {
    sessionService.getSession.mockResolvedValue({ current_step: 'aspiration', completed_steps: [] });
    sessionService.updateProgression.mockResolvedValue({ current_step: 'processing', completed_steps: ['aspiration'] });
    recommendationEngine.initiateGeneration.mockRejectedValue(new Error('db unavailable'));

    await expect(initiateProcessingTransition('user-1')).resolves.toEqual({
      session: { current_step: 'processing', completed_steps: ['aspiration'] },
    });
  });
});
