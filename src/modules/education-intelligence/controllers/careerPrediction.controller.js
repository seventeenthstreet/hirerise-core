'use strict';

const { supabase } = require('../../../config/supabase');
const logger = require('../../../utils/logger');
const repository = require('../repositories/student.repository');
const CareerSuccessEngine = require('../engines/careerSuccess.engine');
const { COLLECTIONS } = require('../models/student.model');

function getAuthenticatedUserId(req) {
  return req.user?.id || req.user?.uid || null;
}

function isAdmin(req) {
  return req.user?.admin === true;
}

function isValidStudentId(studentId) {
  return (
    typeof studentId === 'string' &&
    studentId.trim().length > 0
  );
}

async function predictCareers(req, res, next) {
  try {
    const requestingUserId = getAuthenticatedUserId(req);
    const studentId = req.params?.studentId;

    // ── Input validation ─────────────────────────────────────────────
    if (!isValidStudentId(studentId)) {
      return res.status(400).json({
        success: false,
        errorCode: 'INVALID_STUDENT_ID',
        message: 'studentId path parameter must be a non-empty string.'
      });
    }

    // ── Auth guard ──────────────────────────────────────────────────
    if (requestingUserId !== studentId && !isAdmin(req)) {
      return res.status(403).json({
        success: false,
        errorCode: 'FORBIDDEN',
        message: 'You may only request career predictions for your own profile.'
      });
    }

    logger.info(
      {
        studentId,
        requestingUserId
      },
      '[CareerPrediction] Requested'
    );

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

    const result = await CareerSuccessEngine.analyze(
      {
        studentId,
        student,
        cognitive
      },
      recommendedStream
    );

    const rows = result.top_careers.map((item) => ({
      student_id: studentId,
      career_name: item.career,
      success_probability: item.probability
    }));

    const { error: upsertError } = await supabase
      .from(COLLECTIONS.CAREER_PREDICTIONS)
      .upsert(rows, {
        onConflict: 'student_id,career_name',
        ignoreDuplicates: false
      });

    if (upsertError) throw upsertError;

    logger.info(
      {
        studentId,
        count: rows.length
      },
      '[CareerPrediction] Stored'
    );

    return res.status(200).json({
      success: true,
      data: {
        top_careers: result.top_careers
      }
    });
  } catch (error) {
    logger.error(
      {
        studentId: req.params?.studentId,
        error: error.message
      },
      '[CareerPrediction] Prediction failed'
    );

    return next(error);
  }
}

async function getCareers(req, res, next) {
  try {
    const requestingUserId = getAuthenticatedUserId(req);
    const studentId = req.params?.studentId;

    if (!isValidStudentId(studentId)) {
      return res.status(400).json({
        success: false,
        errorCode: 'INVALID_STUDENT_ID',
        message: 'studentId path parameter must be a non-empty string.'
      });
    }

    if (requestingUserId !== studentId && !isAdmin(req)) {
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
      .order('success_probability', {
        ascending: false
      });

    if (error) throw error;

    if (!data?.length) {
      return res.status(404).json({
        success: false,
        errorCode: 'PREDICTIONS_NOT_FOUND',
        message: 'Run analysis first.'
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        top_careers: data.map((row) => ({
          career: row.career_name,
          probability: row.success_probability
        }))
      }
    });
  } catch (error) {
    logger.error(
      {
        studentId: req.params?.studentId,
        error: error.message
      },
      '[CareerPrediction] Fetch failed'
    );

    return next(error);
  }
}

module.exports = {
  predictCareers,
  getCareers
};