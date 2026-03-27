'use strict';

/**
 * controllers/roiAnalysis.controller.js
 *
 * HTTP handler for the Education ROI Engine endpoint.
 *
 * Endpoints:
 *   POST /api/v1/education/roi-analysis/:studentId  — run ERE, store + return
 *   GET  /api/v1/education/roi-analysis/:studentId  — return stored results
 */

const { db }              = require('../../../config/supabase');
const { FieldValue } = require('../../../config/supabase');
const logger              = require('../../../utils/logger');
const repository          = require('../repositories/student.repository');
const CareerSuccessEngine = require('../engines/careerSuccess.engine');
const EducationROIEngine  = require('../engines/educationROI.engine');
const { COLLECTIONS }     = require('../models/student.model');

// ─── POST /api/v1/education/roi-analysis/:studentId ───────────────────────────

async function analyzeROI(req, res, next) {
  try {
    const requestingUid = req.user.uid;
    const studentId     = req.params.studentId;

    if (requestingUid !== studentId && !req.user.admin) {
      return res.status(403).json({
        success:   false,
        errorCode: 'FORBIDDEN',
        message:   'You may only request ROI analysis for your own profile.',
      });
    }

    logger.info({ studentId }, '[ROIController] ROI analysis requested');

    // ── Fetch prerequisites ────────────────────────────────────────────────
    const [student, cognitive, streamScores] = await Promise.all([
      repository.getStudent(studentId),
      repository.getCognitive(studentId),
      repository.getStreamScores(studentId),
    ]);

    if (!student) {
      return res.status(404).json({
        success:   false,
        errorCode: 'STUDENT_NOT_FOUND',
        message:   'Student profile not found. Complete onboarding first.',
      });
    }

    if (!cognitive) {
      return res.status(422).json({
        success:   false,
        errorCode: 'COGNITIVE_MISSING',
        message:   'Complete the cognitive assessment before running ROI analysis.',
      });
    }

    const recommendedStream = streamScores?.recommended_stream ?? 'engineering';

    // ── Run Career Success Engine to get probabilities ─────────────────────
    const context      = { studentId, student, cognitive };
    const careerResult = await CareerSuccessEngine.analyze(context, recommendedStream);

    // ── Run Education ROI Engine ───────────────────────────────────────────
    const roiResult = await EducationROIEngine.analyze(careerResult, recommendedStream);

    // ── Persist results (replace previous) ────────────────────────────────
    const existingSnap = await db
      .collection(COLLECTIONS.EDUCATION_ROI)
      .where('student_id', '==', studentId)
      .get();

    const batch = db.batch();
    existingSnap.docs.forEach(doc => batch.delete(doc.ref));

    for (const option of roiResult.education_options) {
      const ref = db.collection(COLLECTIONS.EDUCATION_ROI).doc();
      batch.set(ref, {
        student_id:      studentId,
        education_path:  option.path,
        duration_years:  option.duration_years,
        estimated_cost:  option.estimated_cost,
        expected_salary: option.expected_salary,
        roi_score:       option.roi_score,
        roi_level:       option.roi_level,
        matched_careers: option.matched_careers,
        created_at:      FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();

    logger.info({ studentId, count: roiResult.education_options.length },
      '[ROIController] ROI results stored');

    return res.status(200).json({
      success: true,
      data: {
        education_options: roiResult.education_options,
      },
    });

  } catch (err) {
    next(err);
  }
}

// ─── GET /api/v1/education/roi-analysis/:studentId ────────────────────────────

async function getROI(req, res, next) {
  try {
    const requestingUid = req.user.uid;
    const studentId     = req.params.studentId;

    if (requestingUid !== studentId && !req.user.admin) {
      return res.status(403).json({
        success:   false,
        errorCode: 'FORBIDDEN',
        message:   'You may only view your own ROI analysis.',
      });
    }

    const snap = await db
      .collection(COLLECTIONS.EDUCATION_ROI)
      .where('student_id', '==', studentId)
      .orderBy('roi_score', 'desc')
      .get();

    if (snap.empty) {
      return res.status(404).json({
        success:   false,
        errorCode: 'ROI_NOT_FOUND',
        message:   'No ROI analysis found. Run analysis first.',
      });
    }

    const education_options = snap.docs.map(doc => {
      const d = doc.data();
      return {
        path:            d.education_path,
        duration_years:  d.duration_years,
        estimated_cost:  d.estimated_cost,
        expected_salary: d.expected_salary,
        roi_score:       d.roi_score,
        roi_level:       d.roi_level,
        matched_careers: d.matched_careers ?? [],
      };
    });

    return res.status(200).json({
      success: true,
      data: { education_options },
    });

  } catch (err) {
    next(err);
  }
}

module.exports = { analyzeROI, getROI };










