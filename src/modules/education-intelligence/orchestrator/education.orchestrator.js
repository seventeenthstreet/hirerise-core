'use strict';

/**
 * orchestrator/education.orchestrator.js
 *
 * Pipeline:
 *   1.  Load all student data (parallel)
 *   2.  AcademicTrendEngine
 *   3.  CognitiveProfileEngine
 *   4.  ActivityAnalyzerEngine
 *   5.  StreamIntelligenceEngine
 *   6.  CareerSuccessEngine
 *   7.  EducationROIEngine
 *   8.  CareerDigitalTwinEngine
 *   9.  Load LMI market signals
 *  10.  SkillEvolutionEngine        ← NEW
 *  11.  Write all results to Firestore
 *  12.  Return combined result
 */

const logger     = require('../../../utils/logger');
const repository = require('../repositories/student.repository');
const { FieldValue } = require('../../../config/supabase');
const { db }     = require('../../../config/supabase');
const { COLLECTIONS } = require('../models/student.model');

const AcademicTrendEngine      = require('../engines/academicTrend.engine');
const CognitiveProfileEngine   = require('../engines/cognitiveProfile.engine');
const ActivityAnalyzerEngine   = require('../engines/activityAnalyzer.engine');
const StreamIntelligenceEngine = require('../engines/streamIntelligence.engine');
const CareerSuccessEngine      = require('../engines/careerSuccess.engine');
const EducationROIEngine       = require('../engines/educationROI.engine');
const CareerDigitalTwinEngine  = require('../engines/careerDigitalTwin.engine');
const skillEvolutionService    = require('../../skill-evolution/services/skillEvolution.service');
const marketTrendService       = require('../../labor-market-intelligence/services/marketTrend.service');
const ENGINE_VERSION = '1.4.0'; // bumped for SEE integration

async function run(studentId) {
  const startTime = Date.now();
  logger.info({ studentId }, '[EduOrchestrator] Pipeline started');

  try {
    // ── 1. Load all student data in parallel ─────────────────────────────
    const [student, academics, activities, cognitive] = await Promise.all([
      repository.getStudent(studentId),
      repository.getAcademicRecords(studentId),
      repository.getActivities(studentId),
      repository.getCognitive(studentId),
    ]);

    if (!student) {
      const err = new Error(`Student ${studentId} not found`);
      err.statusCode = 404;
      throw err;
    }

    if (!cognitive) {
      const err = new Error(`Cognitive data missing for student ${studentId}. Complete the cognitive assessment first.`);
      err.statusCode = 422;
      throw err;
    }

    const context = { studentId, student, academics, activities, cognitive };

    // ── 2. Academic Trend Engine ─────────────────────────────────────────
    logger.info({ studentId }, '[EduOrchestrator] Running AcademicTrendEngine');
    const academicResult = await AcademicTrendEngine.analyze(context);

    // ── 3. Cognitive Profile Engine ──────────────────────────────────────
    logger.info({ studentId }, '[EduOrchestrator] Running CognitiveProfileEngine');
    const cognitiveResult = await CognitiveProfileEngine.analyze(context);

    // ── 4. Activity Analyzer Engine ──────────────────────────────────────
    logger.info({ studentId }, '[EduOrchestrator] Running ActivityAnalyzerEngine');
    const activityResult = await ActivityAnalyzerEngine.analyze(context);

    // ── 5. Stream Intelligence Engine ────────────────────────────────────
    logger.info({ studentId }, '[EduOrchestrator] Running StreamIntelligenceEngine');
    const streamResult = await StreamIntelligenceEngine.recommend(
      context, academicResult, cognitiveResult, activityResult
    );

    // ── 6. Career Success Probability Engine ─────────────────────────────
    logger.info({ studentId }, '[EduOrchestrator] Running CareerSuccessEngine');
    const careerResult = await CareerSuccessEngine.analyze(context, streamResult.recommended_stream);

    // ── 7. Load LMI market signals (non-blocking — fallback gracefully) ─────
    logger.info({ studentId }, '[EduOrchestrator] Loading LMI market signals');
    let marketScores = {};
    try {
      marketScores = await marketTrendService.getCareerScoresMap();
    } catch (lmiErr) {
      logger.warn({ err: lmiErr.message }, '[EduOrchestrator] LMI unavailable — using static signals');
    }

    // ── 8. Education ROI Engine ───────────────────────────────────────────
    logger.info({ studentId }, '[EduOrchestrator] Running EducationROIEngine');
    const roiResult = await EducationROIEngine.analyze(careerResult, streamResult.recommended_stream, marketScores);

    // ── 9. Career Digital Twin Engine ────────────────────────────────────
    logger.info({ studentId }, '[EduOrchestrator] Running CareerDigitalTwinEngine');
    const twinResult = await CareerDigitalTwinEngine.simulate(
      careerResult, roiResult, cognitiveResult, academicResult, marketScores
    );

    // ── 10. Skill Evolution Engine ────────────────────────────────────────
    logger.info({ studentId }, '[EduOrchestrator] Running SkillEvolutionEngine');
    let skillResult = {
      skills:             [],
      roadmap:            [],
      top_career:         careerResult?.top_careers?.[0]?.career ?? null,
      recommended_stream: streamResult.recommended_stream,
      engine_version:     '1.0.0',
    };
    try {
      skillResult = await skillEvolutionService.generateRecommendations(studentId, {
        careerResult,
        streamResult,
        cognitiveResult,
      });
    } catch (seeErr) {
      logger.warn({ err: seeErr.message }, '[EduOrchestrator] SEE failed gracefully — empty skills returned');
    }

    // ── 11a. Write stream scores ───────────────────────────────────────────
    await db.collection(COLLECTIONS.STREAM_SCORES).doc(studentId).set({
      student_id:         studentId,
      engineering_score:  streamResult.stream_scores.engineering ?? null,
      medical_score:      streamResult.stream_scores.medical     ?? null,
      commerce_score:     streamResult.stream_scores.commerce    ?? null,
      humanities_score:   streamResult.stream_scores.humanities  ?? null,
      recommended_stream: streamResult.recommended_stream,
      recommended_label:  streamResult.recommended_label,
      confidence:         streamResult.confidence,
      alternative_stream: streamResult.alternative_stream,
      alternative_label:  streamResult.alternative_label,
      rationale:          streamResult.rationale,
      engine_version:     ENGINE_VERSION,
      calculated_at:      FieldValue.serverTimestamp(),
    }, { merge: true });

    // ── 11b. Write career predictions ──────────────────────────────────────
    const careerBatch = db.batch();
    for (const item of careerResult.top_careers) {
      const ref = db.collection(COLLECTIONS.CAREER_PREDICTIONS).doc();
      careerBatch.set(ref, {
        student_id:          studentId,
        career_name:         item.career,
        success_probability: item.probability,
        created_at:          FieldValue.serverTimestamp(),
      });
    }
    await careerBatch.commit();

    // ── 11c. Write ROI results ─────────────────────────────────────────────
    const roiBatch = db.batch();
    const existingROI = await db
      .collection(COLLECTIONS.EDUCATION_ROI)
      .where('student_id', '==', studentId)
      .get();
    existingROI.docs.forEach(doc => roiBatch.delete(doc.ref));

    for (const option of roiResult.education_options) {
      const ref = db.collection(COLLECTIONS.EDUCATION_ROI).doc();
      roiBatch.set(ref, {
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
    await roiBatch.commit();

    // ── 11d. Write career simulations ──────────────────────────────────────
    const twinBatch = db.batch();
    const existingSims = await db
      .collection(COLLECTIONS.CAREER_SIMULATIONS)
      .where('student_id', '==', studentId)
      .get();
    existingSims.docs.forEach(doc => twinBatch.delete(doc.ref));

    for (const sim of twinResult.simulations) {
      const ref = db.collection(COLLECTIONS.CAREER_SIMULATIONS).doc();
      twinBatch.set(ref, {
        student_id:          studentId,
        career_name:         sim.career,
        probability:         sim.probability,
        entry_salary:        sim.entry_salary,
        salary_3_year:       sim.salary_3_year,
        salary_5_year:       sim.salary_5_year,
        salary_10_year:      sim.salary_10_year,
        annual_growth_rate:  sim.annual_growth_rate,
        demand_level:        sim.demand_level,
        roi_level:           sim.roi_level,
        best_education_path: sim.best_education_path,
        milestones:          sim.milestones,
        created_at:          FieldValue.serverTimestamp(),
      });
    }
    await twinBatch.commit();

    const elapsed = Date.now() - startTime;
    logger.info({ studentId, elapsed, recommended: streamResult.recommended_stream },
      '[EduOrchestrator] Pipeline complete');

    return {
      academic:  academicResult,
      cognitive: cognitiveResult,
      activity:  activityResult,
      stream:    streamResult,
      careers:   careerResult,
      roi:       roiResult,
      twin:      twinResult,
      skills:    skillResult,
    };

  } catch (err) {
    logger.error({ studentId, err: err.message }, '[EduOrchestrator] Pipeline failed');
    throw err;
  }
}

module.exports = { run };









