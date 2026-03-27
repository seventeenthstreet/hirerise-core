'use strict';

/**
 * controllers/careerPrediction.controller.js
 *
 * HTTP handler for the Career Success Probability Engine endpoint.
 *
 * Endpoint:
 *   POST /api/v1/education/career-prediction/:studentId
 *
 * Flow:
 *   1. Auth guard  — student may only query their own profile (admin override)
 *   2. Fetch student + cognitive data
 *   3. Run CareerSuccessEngine
 *   4. Persist predictions to edu_career_predictions
 *   5. Return ranked top_careers
 *
 * Response 200:
 * {
 *   success: true,
 *   data: {
 *     top_careers: [
 *       { career: "Software Engineer", probability: 82 },
 *       ...\n *     ]
 *   }
 * }
 */
const supabase = require('../../../core/supabaseClient');
const logger = require('../../../utils/logger');
const repository = require('../repositories/student.repository');
const CareerSuccessEngine = require('../engines/careerSuccess.engine');
const { COLLECTIONS } = require('../models/student.model');

// ─── POST /api/v1/education/career-prediction/:studentId ──────────────────────

async function predictCareers(req, res, next) {
  try {
    const requestingUid = req.user.uid;
    const studentId = req.params.studentId;

    // ── Auth guard ─────────────────────────────────────────────────────────
    if (requestingUid !== studentId && !req.user.admin) {
      return res.status(403).json({
        success: false,
        errorCode: 'FORBIDDEN',
        message: 'You may only request career predictions for your own profile.'
      });
    }

    // ── Input guard ────────────────────────────────────────────────────────
    if (!studentId || typeof studentId !== 'string' || studentId.trim().length === 0) {
      return res.status(400).json({
        success: false,
        errorCode: 'INVALID_STUDENT_ID',
        message: 'studentId path parameter must be a non-empty string.'
      });
    }
    logger.info({ studentId, requestingUid }, '[CareerPredictionController] Prediction requested');

    // ── Fetch student profile & cognitive data ─────────────────────────────
    const [student, cognitive, streamScores] = await Promise.all([
      repository.getStudent(studentId),
      repository.getCognitive(studentId),
      repository.getStreamScores(studentId)
    ]);
    if (!student) {
      return res.status(404).json({
        success: false,
        errorCode: 'STUDENT_NOT_FOUND',
        message: 'Student profile not found. Complete onboarding first.'
      });
    }
    if (!cognitive) {
      return res.status(422).json({
        success: false,
        errorCode: 'COGNITIVE_MISSING',
        message: 'Cognitive assessment not completed. Please finish the cognitive test first.'
      });
    }

    // Determine recommended stream (from previous analysis, or default)
    const recommendedStream = streamScores?.recommended_stream ?? 'engineering';

    // ── Run Career Success Engine ──────────────────────────────────────────
    const context = { studentId, student, cognitive };
    const result = await CareerSuccessEngine.analyze(context, recommendedStream);

    // ── Persist predictions (replace previous batch) ──────────────────────
    // Delete existing predictions for this student first, then insert new ones
    const now = new Date().toISOString();

    await supabase
      .from(COLLECTIONS.CAREER_PREDICTIONS)
      .delete()
      .eq('student_id', studentId);

    const predictionsToInsert = result.top_careers.map(item => ({
      student_id: studentId,
      career_name: item.career,
      success_probability: item.probability,
      created_at: now
    }));

    if (predictionsToInsert.length > 0) {
      const { error: insertError } = await supabase
        .from(COLLECTIONS.CAREER_PREDICTIONS)
        .insert(predictionsToInsert);
      if (insertError) throw insertError;
    }

    logger.info(
      { studentId, count: result.top_careers.length },
      '[CareerPredictionController] Predictions stored'
    );
    return res.status(200).json({
      success: true,
      data: { top_careers: result.top_careers }
    });
  } catch (err) {
    next(err);
  }
}

// ─── GET /api/v1/education/career-prediction/:studentId ───────────────────────

async function getCareers(req, res, next) {
  try {
    const requestingUid = req.user.uid;
    const studentId = req.params.studentId;
    if (requestingUid !== studentId && !req.user.admin) {
      return res.status(403).json({
        success: false,
        errorCode: 'FORBIDDEN',
        message: 'You may only view your own career predictions.'
      });
    }

    const { data, error } = await supabase
      .from(COLLECTIONS.CAREER_PREDICTIONS)
      .select('career_name, success_probability')
      .eq('student_id', studentId)
      .order('success_probability', { ascending: false });

    if (error) throw error;

    if (!data || data.length === 0) {
      return res.status(404).json({
        success: false,
        errorCode: 'PREDICTIONS_NOT_FOUND',
        message: 'No career predictions found. Run analysis first.'
      });
    }

    const topCareers = data.map(row => ({
      career: row.career_name,
      probability: row.success_probability
    }));

    return res.status(200).json({
      success: true,
      data: { top_careers: topCareers }
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  predictCareers,
  getCareers
};