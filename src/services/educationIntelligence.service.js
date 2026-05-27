'use strict';

/**
 * services/educationIntelligence.service.js
 *
 * Bounded orchestration service for the education-intelligence domain.
 *
 * Owns all direct engine coordination for:
 *   - career success prediction (CareerSuccessEngine)
 *   - education ROI analysis  (EducationROIEngine)
 *   - career digital twin simulation (CareerDigitalTwinEngine)
 *
 * Controllers and collectors call this service.
 * They do NOT import engines directly.
 *
 * Architecture:
 *   controller/collector → educationIntelligence.service → engine
 *
 * Constraints:
 *   - Explicit methods only; no abstract runners or factory patterns
 *   - Preserves execution order and async semantics of original controller code
 *   - Does not introduce service → service chains
 */

const studentRepository = require('../modules/education-intelligence/repositories/student.repository');
const CareerSuccessEngine = require('../engines/careerSuccess.engine');
const EducationROIEngine = require('../engines/educationROI.engine');
const CareerDigitalTwinEngine = require('../engines/careerDigitalTwin.engine');

// ─── Student Context ──────────────────────────────────────────────────────────

/**
 * Fetch the full student context required by analysis operations.
 *
 * Runs getStudent, getCognitive, and getStreamScores in parallel.
 * All controllers and collectors must use this method instead of
 * importing student.repository directly.
 *
 * @param {string} studentId
 * @returns {Promise<{ student: object|null, cognitive: object|null, streamScores: object|null }>}
 */
async function getStudentContext(studentId) {
  const [student, cognitive, streamScores] = await Promise.all([
    studentRepository.getStudent(studentId),
    studentRepository.getCognitive(studentId),
    studentRepository.getStreamScores(studentId),
  ]);

  return { student, cognitive, streamScores };
}

// ─── Career Success ───────────────────────────────────────────────────────────

/**
 * Run the CareerSuccessEngine analysis for a student.
 *
 * @param {{ studentId: string, student: object, cognitive: object }} context
 * @param {string} recommendedStream
 * @returns {Promise<object>} careerResult
 */
async function predictCareers(context, recommendedStream) {
  return CareerSuccessEngine.analyze(context, recommendedStream);
}

// ─── Education ROI ────────────────────────────────────────────────────────────

/**
 * Run the EducationROIEngine analysis given a career result.
 *
 * @param {object} careerResult  Output from predictCareers()
 * @param {string} recommendedStream
 * @returns {Promise<object>} roiResult
 */
async function analyzeROI(careerResult, recommendedStream) {
  return EducationROIEngine.analyze(careerResult, recommendedStream);
}

// ─── Career + ROI (combined — avoids duplicate CareerSuccess calls) ───────────

/**
 * Run CareerSuccessEngine then EducationROIEngine in sequence.
 * Used by roiAnalysis controllers to avoid two round-trips through CareerSuccess.
 *
 * @param {{ studentId: string, student: object, cognitive: object }} context
 * @param {string} recommendedStream
 * @returns {Promise<{ careerResult: object, roiResult: object }>}
 */
async function predictCareersAndROI(context, recommendedStream) {
  const careerResult = await CareerSuccessEngine.analyze(context, recommendedStream);
  const roiResult = await EducationROIEngine.analyze(careerResult, recommendedStream);
  return { careerResult, roiResult };
}

// ─── Career Simulation (full pipeline) ───────────────────────────────────────

/**
 * Run the full simulation pipeline:
 *   CareerSuccessEngine → EducationROIEngine → CareerDigitalTwinEngine
 *
 * @param {{ studentId: string, student: object, cognitive: object }} context
 * @param {string} recommendedStream
 * @returns {Promise<{ careerResult: object, roiResult: object, twinResult: object }>}
 */
async function simulateCareers(context, recommendedStream) {
  const { studentId, cognitive } = context;

  const careerResult = await CareerSuccessEngine.analyze(context, recommendedStream);
  const roiResult = await EducationROIEngine.analyze(careerResult, recommendedStream);

  const cognitiveProxy = {
    scores: {
      analytical: cognitive.analytical_score,
      logical: cognitive.logical_score,
      memory: cognitive.memory_score,
      communication: cognitive.communication_score,
      creativity: cognitive.creativity_score
    }
  };

  const twinResult = await CareerDigitalTwinEngine.simulate(
    careerResult,
    roiResult,
    cognitiveProxy,
    null
  );

  return { careerResult, roiResult, twinResult };
}

module.exports = {
  getStudentContext,
  predictCareers,
  analyzeROI,
  predictCareersAndROI,
  simulateCareers
};