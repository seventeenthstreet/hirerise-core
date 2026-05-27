'use strict';

/**
 * core/src/modules/student-onboarding/services/academic.service.js
 *
 * BUSINESS LOGIC — Academic Signal Collection (Phase 3A)
 *
 * DOES NOT:
 *   • access the database directly (delegates to academic.repository.js)
 *   • handle HTTP (belongs in controller)
 *   • evaluate signal quality inline (delegates to academic-signal-quality.js)
 *   • normalize subjects inline (delegates to academic-normalization.js)
 *
 * PROGRESSIVE PERSISTENCE CONTRACT:
 *   • getAcademicsStep  — reads all saved academic records for the step UI
 *   • saveAcademicsStep — partial or full save of one academic year;
 *                         advances session when signal is sufficient
 */

const repo           = require('../repositories/academic.repository');
const sessionService = require('./session.service');

const { normalizeAcademicYears }          = require('../helpers/academic-normalization');
const { evaluateAcademicSignalQuality }   = require('../helpers/academic-signal-quality');
const { addCompletedStep, resolveCurrentStep } = require('../helpers/progression');
const { ACADEMIC_BOARD_TYPES }            = require('../constants/academics');

// ─────────────────────────────────────────────────────────────────────────────
// GET ACADEMICS STEP
// Returns all saved academic records shaped for the step UI.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {{ supabase: object, diagnostics?: object }} ctx
 * @param {string} userId
 * @param {string} sessionId
 * @returns {Promise<{ academics: { years: object }, signal_quality: object }>}
 */
async function getAcademicsStep(ctx, userId, sessionId) {
  const { supabase } = ctx;

  const { records, subjects } = await repo.fetchAcademicData(supabase, userId);

  const years         = repo.groupAcademicData(records, subjects);
  const yearSummaries = repo.buildYearSummaries(records);
  const signalQuality = evaluateAcademicSignalQuality(yearSummaries);

  return {
    academics:      { years },
    signal_quality: signalQuality,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SAVE ACADEMICS STEP
// Partial or full save of one or more academic years.
// When signal becomes sufficient and is_partial = false, advances session.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {{ supabase: object, diagnostics?: object }} ctx
 * @param {string} userId
 * @param {string} sessionId
 * @param {{ years: object, is_partial: boolean }} validatedBody — output of validator middleware
 * @returns {Promise<{ academics: { years: object }, session: object, next_step: string, signal_quality: object }>}
 */
async function saveAcademicsStep(ctx, userId, sessionId, validatedBody) {
  const { supabase }  = ctx;
  const { years: yearsInput, is_partial: isPartial } = validatedBody;

  // Normalize subjects and compute derived fields (percentage, grade inference)
  const normalizedYears = normalizeAcademicYears(yearsInput, ACADEMIC_BOARD_TYPES);

  // Persist each year sequentially — each year is an independent upsert
  for (const [yearKey, yearData] of Object.entries(normalizedYears)) {
    const subjects       = yearData.subjects ?? [];
    const subjectCount   = subjects.length;

    const record = await repo.upsertAcademicRecord(supabase, {
      user_id:       userId,
      academic_year: yearKey,
      board_type:    yearData.board_type,
      is_partial:    isPartial,
      is_predicted:  yearData.is_predicted ?? false,
      subject_count: subjectCount,
    });

    // Delete subjects no longer present (handles subject removal on re-save)
    const keepSubjects = subjects.map((s) => s.subject);
    await repo.deleteRemovedSubjects(supabase, userId, yearKey, keepSubjects);

    if (subjects.length > 0) {
      await repo.upsertAcademicSubjects(supabase, userId, yearKey, record.id, subjects);
    }
  }

  // Re-read authoritative state from DB after write
  const { records, subjects: allSubjects } = await repo.fetchAcademicData(supabase, userId);
  const years         = repo.groupAcademicData(records, allSubjects);
  const yearSummaries = repo.buildYearSummaries(records);
  const signalQuality = evaluateAcademicSignalQuality(yearSummaries);

  // Advance session when the student completes a non-partial save with sufficient signal
  const currentSession = await sessionService.getSession(userId);
  const newCompleted   = addCompletedStep(currentSession.completed_steps, 'academics');
  const nextStep       = resolveCurrentStep('academics', currentSession.current_step);

  const updatedSession = await sessionService.updateProgression(userId, {
    completedStep:  'academics',
    nextStep,
    completedSteps: newCompleted,
  });

  return {
    academics:      { years },
    session:        updatedSession,
    next_step:      nextStep,
    signal_quality: signalQuality,
  };
}

module.exports = {
  getAcademicsStep,
  saveAcademicsStep,
};
