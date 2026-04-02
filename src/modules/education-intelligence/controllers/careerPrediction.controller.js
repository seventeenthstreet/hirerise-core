'use strict';

const { supabase } = require('../../../config/supabase');
const logger = require('../../../utils/logger');
const repository = require('../repositories/student.repository');
const CareerSuccessEngine = require('../engines/careerSuccess.engine');
const { COLLECTIONS } = require('../models/student.model');

// ─── POST ─────────────────────────────────────────────────────────────────────

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

    logger.info({ studentId, requestingUid }, '[CareerPrediction] Requested');

    // ── Fetch data ─────────────────────────────────────────────────────────
    const [student, cognitive, streamScores] = await Promise.all([
      repository.getStudent(studentId),
      repository.getCognitive(studentId),
      repository.getStreamScores(studentId)
    ]);

    if (!student) {
      return res.status(404).json({
        success: false,
        errorCode: 'STUDENT_NOT_FOUND',
        message: 'Student profile not found.'
      });
    }

    if (!cognitive) {
      return res.status(422).json({
        success: false,
        errorCode: 'COGNITIVE_MISSING',
        message: 'Complete cognitive test first.'
      });
    }

    const recommendedStream =
      streamScores?.recommended_stream ?? 'engineering';

    // ── Run engine ─────────────────────────────────────────────────────────
    const context = { studentId, student, cognitive };

    const result = await CareerSuccessEngine.analyze(
      context,
      recommendedStream
    );

    const now = new Date().toISOString();

    // ── Delete existing predictions ────────────────────────────────────────
    const { error: deleteError } = await supabase
      .from(COLLECTIONS.CAREER_PREDICTIONS)
      .delete()
      .eq('student_id', studentId);

    if (deleteError) throw deleteError;

    // ── Insert new predictions ─────────────────────────────────────────────
    const rows = result.top_careers.map(item => ({
      student_id: studentId,
      career_name: item.career,
      success_probability: item.probability,
      created_at: now
    }));

    const { error: insertError } = await supabase
      .from(COLLECTIONS.CAREER_PREDICTIONS)
      .insert(rows);

    if (insertError) throw insertError;

    logger.info({
      studentId,
      count: rows.length
    }, '[CareerPrediction] Stored');

    return res.status(200).json({
      success: true,
      data: {
        top_careers: result.top_careers
      }
    });

  } catch (err) {
    next(err);
  }
}

// ─── GET ──────────────────────────────────────────────────────────────────────

async function getCareers(req, res, next) {
  try {
    const requestingUid = req.user.uid;
    const studentId = req.params.studentId;

    if (requestingUid !== studentId && !req.user.admin) {
      return res.status(403).json({
        success: false,
        errorCode: 'FORBIDDEN',
        message: 'You may only view your own predictions.'
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
        message: 'Run analysis first.'
      });
    }

    const topCareers = data.map(row => ({
      career: row.career_name,
      probability: row.success_probability
    }));

    return res.status(200).json({
      success: true,
      data: {
        top_careers: topCareers
      }
    });

  } catch (err) {
    next(err);
  }
}

module.exports = {
  predictCareers,
  getCareers
};
