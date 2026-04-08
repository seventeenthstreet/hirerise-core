'use strict';

/**
 * careerPrediction.controller.js — Optimized
 *
 * ✅ Supabase optimized
 * ✅ Safer DB writes (upsert)
 * ✅ Crash protection
 * ✅ Timeout protection
 * ✅ Cleaner error handling
 */

const { supabase } = require('../../../config/supabase');
const logger = require('../utils/logger');
const repository = require('../repositories/student.repository');
const CareerSuccessEngine = require('../engines/careerSuccess.engine');
const { COLLECTIONS } = require('../models/student.model');

// Timeout wrapper (prevents hanging requests)
const withTimeout = (promise, ms = 5000) => {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('ENGINE_TIMEOUT')), ms)
    )
  ]);
};

// ─────────────────────────────────────────────
// POST: Predict Careers
// ─────────────────────────────────────────────
async function predictCareers(req, res, next) {
  try {
    const requestingUid = req.user.id;
    const studentId = req.params.studentId;

    // ── Auth guard ───────────────────────────
    if (requestingUid !== studentId && !req.user.admin) {
      return res.status(403).json({
        success: false,
        errorCode: 'FORBIDDEN',
        message: 'You may only request your own predictions.'
      });
    }

    if (!studentId || typeof studentId !== 'string') {
      return res.status(400).json({
        success: false,
        errorCode: 'INVALID_STUDENT_ID',
        message: 'Invalid studentId'
      });
    }

    logger.info({ studentId }, '[CareerPrediction] Started');

    // ── Fetch data in parallel ───────────────
    const [student, cognitive, streamScores] = await Promise.all([
      repository.getStudent(studentId),
      repository.getCognitive(studentId),
      repository.getStreamScores(studentId)
    ]);

    if (!student) {
      return res.status(404).json({
        success: false,
        errorCode: 'STUDENT_NOT_FOUND',
        message: 'Student not found'
      });
    }

    if (!cognitive) {
      return res.status(422).json({
        success: false,
        errorCode: 'COGNITIVE_MISSING',
        message: 'Cognitive test required'
      });
    }

    const recommendedStream =
      streamScores?.recommended_stream || 'engineering';

    // ── Run engine with timeout ──────────────
    const context = { studentId, student, cognitive };

    const result = await withTimeout(
      CareerSuccessEngine.analyze(context, recommendedStream),
      7000
    );

    if (!result || !Array.isArray(result.top_careers)) {
      throw new Error('INVALID_ENGINE_RESPONSE');
    }

    // ── Prepare data ─────────────────────────
    const now = new Date().toISOString();

    const rows = result.top_careers.map(item => ({
      student_id: studentId,
      career_name: item.career,
      success_probability: item.probability,
      created_at: now
    }));

    // ── UPSERT instead of delete+insert ─────
    const { error } = await supabase
      .from(COLLECTIONS.CAREER_PREDICTIONS)
      .upsert(rows, {
        onConflict: 'student_id,career_name'
      });

    if (error) throw error;

    logger.info(
      { studentId, count: rows.length },
      '[CareerPrediction] Stored successfully'
    );

    return res.status(200).json({
      success: true,
      data: { top_careers: result.top_careers }
    });

  } catch (err) {
    logger.error('[CareerPrediction] Failed', {
      error: err.message
    });
    next(err);
  }
}

// ─────────────────────────────────────────────
// GET: Fetch Predictions
// ─────────────────────────────────────────────
async function getCareers(req, res, next) {
  try {
    const requestingUid = req.user.id;
    const studentId = req.params.studentId;

    if (requestingUid !== studentId && !req.user.admin) {
      return res.status(403).json({
        success: false,
        errorCode: 'FORBIDDEN'
      });
    }

    const { data, error } = await supabase
      .from(COLLECTIONS.CAREER_PREDICTIONS)
      .select('career_name, success_probability')
      .eq('student_id', studentId)
      .order('success_probability', { ascending: false });

    if (error) throw error;

    if (!data?.length) {
      return res.status(404).json({
        success: false,
        errorCode: 'NO_PREDICTIONS'
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        top_careers: data.map(d => ({
          career: d.career_name,
          probability: d.success_probability
        }))
      }
    });

  } catch (err) {
    logger.error('[CareerPrediction] Fetch failed', {
      error: err.message
    });
    next(err);
  }
}

module.exports = {
  predictCareers,
  getCareers
};