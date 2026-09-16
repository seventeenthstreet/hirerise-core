'use strict';

/**
 * modules/student-onboarding/__tests__/academic.service.test.js
 *
 * Regression coverage for the Bug 1 root cause: saveAcademicsStep() used to
 * call sessionService.updateProgression() unconditionally on EVERY save —
 * including partial autosaves — silently marking 'academics' complete and
 * advancing current_step to 'activities' before the student ever clicked
 * Continue. See the ROOT CAUSE comment in academic.service.js for the full
 * writeup of how that trapped the frontend behind StepRouter's REVIEW
 * BRANCH, making Continue look enabled but do nothing.
 *
 * These tests assert the fixed contract: progression only advances on a
 * commit save (is_partial: false) with sufficient signal quality. Every
 * other case must leave the session untouched.
 */

jest.mock('../repositories/academic.repository');
jest.mock('../services/session.service');

const repo                  = require('../repositories/academic.repository');
const sessionService         = require('../services/session.service');
const { saveAcademicsStep } = require('../services/academic.service');

const ctx = { supabase: { fake: true } };

function baseRepoMocks() {
  repo.upsertAcademicRecord.mockResolvedValue({ id: 'record-1' });
  repo.deleteRemovedSubjects.mockResolvedValue(undefined);
  repo.upsertAcademicSubjects.mockResolvedValue(undefined);
  repo.fetchAcademicData.mockResolvedValue({ records: [], subjects: [] });
  repo.groupAcademicData.mockReturnValue({});
}

describe('academic.service — saveAcademicsStep progression gating', () => {
  afterEach(() => jest.clearAllMocks());

  it('does NOT advance the session on a partial autosave, even with a sufficient subject count', async () => {
    baseRepoMocks();
    // 4 subjects would satisfy Option A — but this is a partial save.
    repo.buildYearSummaries.mockReturnValue([
      { academic_year: 'class_10', subject_count: 4, is_partial: true },
    ]);
    sessionService.getSession.mockResolvedValue({
      current_step: 'academics',
      completed_steps: [],
    });

    const result = await saveAcademicsStep(ctx, 'user-1', 'session-1', {
      years: {
        class_10: {
          board_type: 'cbse',
          is_predicted: false,
          subjects: [{ subject: 'mathematics', marks_obtained: 90, max_marks: 100 }],
        },
      },
      is_partial: true,
    });

    expect(sessionService.updateProgression).not.toHaveBeenCalled();
    expect(result.next_step).toBe('academics');
    expect(result.session).toEqual({ current_step: 'academics', completed_steps: [] });
  });

  it('does NOT advance the session on a commit save when signal quality is insufficient', async () => {
    baseRepoMocks();
    repo.buildYearSummaries.mockReturnValue([
      { academic_year: 'class_10', subject_count: 1, is_partial: false },
    ]);
    sessionService.getSession.mockResolvedValue({
      current_step: 'academics',
      completed_steps: [],
    });

    const result = await saveAcademicsStep(ctx, 'user-1', 'session-1', {
      years: {
        class_10: {
          board_type: 'cbse',
          is_predicted: false,
          subjects: [{ subject: 'mathematics', marks_obtained: 90, max_marks: 100 }],
        },
      },
      is_partial: false,
    });

    expect(sessionService.updateProgression).not.toHaveBeenCalled();
    expect(result.next_step).toBe('academics');
  });

  it('advances the session ONLY on a commit save with sufficient signal quality', async () => {
    baseRepoMocks();
    repo.buildYearSummaries.mockReturnValue([
      { academic_year: 'class_10', subject_count: 4, is_partial: false },
    ]);
    sessionService.getSession.mockResolvedValue({
      current_step: 'academics',
      completed_steps: ['education'],
    });
    sessionService.updateProgression.mockResolvedValue({
      current_step: 'activities',
      completed_steps: ['education', 'academics'],
    });

    const result = await saveAcademicsStep(ctx, 'user-1', 'session-1', {
      years: {
        class_10: {
          board_type: 'cbse',
          is_predicted: false,
          subjects: [
            { subject: 'mathematics', marks_obtained: 90, max_marks: 100 },
            { subject: 'science', marks_obtained: 85, max_marks: 100 },
            { subject: 'english', marks_obtained: 88, max_marks: 100 },
            { subject: 'computer_science', marks_obtained: 92, max_marks: 100 },
          ],
        },
      },
      is_partial: false,
    });

    expect(sessionService.updateProgression).toHaveBeenCalledWith('user-1', {
      completedStep: 'academics',
      nextStep: 'activities',
      completedSteps: ['education', 'academics'],
    });
    expect(result.next_step).toBe('activities');
    expect(result.session).toEqual({
      current_step: 'activities',
      completed_steps: ['education', 'academics'],
    });
  });
});
