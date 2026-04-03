'use strict';

const { supabase } = require('../../../config/supabase');
const logger = require('../../../utils/logger');
const repository = require('../repositories/student.repository');
const CareerSuccessEngine = require('../engines/careerSuccess.engine');
const EducationROIEngine = require('../engines/educationROI.engine');
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

/**
 * Atomic UPSERT for ROI options.
 * Requires UNIQUE(student_id, education_path)
 */
async function replaceROIOptions(studentId, options) {
  const rows = options.map((option) => ({
    student_id: studentId,
    education_path: option.path,
    duration_years: option.duration_years,
    estimated_cost: option.estimated_cost,
    expected_salary: option.expected_salary,
    roi_score: option.roi_score,
    roi_level: option.roi_level,
    matched_careers: option.matched_careers ?? []
  }));

  const { error } = await supabase
    .from(COLLECTIONS.EDUCATION_ROI)
    .upsert(rows, {
      onConflict: 'student_id,education_path'
    });

  if (error) {
    logger.error(
      {
        studentId,
        error: error.message
      },
      '[ROIController] Failed to persist ROI options'
    );
    throw error;
  }
}

async function analyzeROI(req, res, next) {
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
        message: 'You may only request ROI analysis for your own profile.'
      });
    }

    logger.info(
      { studentId, requestingUserId },
      '[ROIController] ROI analysis requested'
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
        message: 'Student profile not found. Complete onboarding first.'
      });
    }

    if (!cognitive) {
      return res.status(422).json({
        success: false,
        errorCode: 'COGNITIVE_MISSING',
        message:
          'Complete the cognitive assessment before running ROI analysis.'
      });
    }

    const recommendedStream =
      streamScores?.recommended_stream ?? 'engineering';

    const careerResult = await CareerSuccessEngine.analyze(
      {
        studentId,
        student,
        cognitive
      },
      recommendedStream
    );

    const roiResult = await EducationROIEngine.analyze(
      careerResult,
      recommendedStream
    );

    await replaceROIOptions(
      studentId,
      roiResult.education_options
    );

    logger.info(
      {
        studentId,
        count: roiResult.education_options.length
      },
      '[ROIController] ROI results stored'
    );

    return res.status(200).json({
      success: true,
      data: {
        education_options: roiResult.education_options
      }
    });
  } catch (error) {
    logger.error(
      {
        studentId: req.params?.studentId,
        error: error.message
      },
      '[ROIController] ROI analysis failed'
    );

    return next(error);
  }
}

async function getROI(req, res, next) {
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
        message: 'You may only view your own ROI analysis.'
      });
    }

    const { data, error } = await supabase
      .from(COLLECTIONS.EDUCATION_ROI)
      .select(`
        education_path,
        duration_years,
        estimated_cost,
        expected_salary,
        roi_score,
        roi_level,
        matched_careers
      `)
      .eq('student_id', studentId)
      .order('roi_score', { ascending: false });

    if (error) throw error;

    if (!data?.length) {
      return res.status(404).json({
        success: false,
        errorCode: 'ROI_NOT_FOUND',
        message: 'No ROI analysis found. Run analysis first.'
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        education_options: data.map((d) => ({
          path: d.education_path,
          duration_years: d.duration_years,
          estimated_cost: d.estimated_cost,
          expected_salary: d.expected_salary,
          roi_score: d.roi_score,
          roi_level: d.roi_level,
          matched_careers: d.matched_careers ?? []
        }))
      }
    });
  } catch (error) {
    logger.error(
      {
        studentId: req.params?.studentId,
        error: error.message
      },
      '[ROIController] Fetch failed'
    );

    return next(error);
  }
}

module.exports = {
  analyzeROI,
  getROI
};