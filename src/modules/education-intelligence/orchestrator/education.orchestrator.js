'use strict';

const logger = require('../../../utils/logger');
const repository = require('../repositories/student.repository');
const { supabase } = require('../../../config/supabase');
const { TABLES } = require('../models/student.model');

const AcademicTrendEngine = require('../engines/academicTrend.engine');
const CognitiveProfileEngine = require('../engines/cognitiveProfile.engine');
const ActivityAnalyzerEngine = require('../engines/activityAnalyzer.engine');
const StreamIntelligenceEngine = require('../engines/streamIntelligence.engine');
const CareerSuccessEngine = require('../engines/careerSuccess.engine');
const EducationROIEngine = require('../engines/educationROI.engine');
const CareerDigitalTwinEngine = require('../engines/careerDigitalTwin.engine');

const skillEvolutionService = require('../../skill-evolution/services/skillEvolution.service');
const marketTrendService = require('../../labor-market-intelligence/services/marketTrend.service');

const ENGINE_VERSION = '1.4.0';

/**
 * Logs non-fatal persistence failures without breaking the orchestration pipeline.
 *
 * @param {string} fn
 * @param {string} studentId
 * @param {Error | null} error
 */
function logNonFatalWrite(fn, studentId, error) {
  if (!error) return;

  logger.warn(
    { fn, studentId, err: error.message },
    '[EduOrchestrator] Non-fatal persistence failure'
  );
}

/**
 * Atomic row replacement using PostgreSQL SECURITY DEFINER RPC.
 * Guarantees DELETE + INSERT happens transactionally.
 *
 * @param {string} fn
 * @param {string} studentId
 * @param {Array<object>} rows
 * @returns {Promise<number>}
 */
async function atomicReplace(fn, studentId, rows) {
  const { data, error } = await supabase.rpc(fn, {
    p_student_id: studentId,
    p_rows: rows || [],
  });

  logNonFatalWrite(fn, studentId, error);

  const inserted = data ?? 0;

  logger.info(
    { fn, studentId, inserted },
    '[EduOrchestrator] Atomic replacement complete'
  );

  return inserted;
}

async function run(studentId) {
  const startedAt = Date.now();

  logger.info({ studentId }, '[EduOrchestrator] Pipeline started');

  try {
    // ───────────────────────────────────────────────────────────────────────
    // 1) Load all student inputs in parallel
    // ───────────────────────────────────────────────────────────────────────
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
      const err = new Error(
        `Cognitive data missing for student ${studentId}. Complete the cognitive assessment first.`
      );
      err.statusCode = 422;
      throw err;
    }

    const context = {
      studentId,
      student,
      academics,
      activities,
      cognitive,
    };

    // ───────────────────────────────────────────────────────────────────────
    // 2–10) Intelligence engines
    // ───────────────────────────────────────────────────────────────────────
    const academicResult = await AcademicTrendEngine.analyze(context);
    const cognitiveResult = await CognitiveProfileEngine.analyze(context);
    const activityResult = await ActivityAnalyzerEngine.analyze(context);

    const streamResult = await StreamIntelligenceEngine.recommend(
      context,
      academicResult,
      cognitiveResult,
      activityResult
    );

    const careerResult = await CareerSuccessEngine.analyze(
      context,
      streamResult.recommended_stream
    );

    let marketScores = {};

    try {
      marketScores = await marketTrendService.getCareerScoresMap();
    } catch (error) {
      logger.warn(
        { studentId, err: error.message },
        '[EduOrchestrator] LMI unavailable — static fallback used'
      );
    }

    const roiResult = await EducationROIEngine.analyze(
      careerResult,
      streamResult.recommended_stream,
      marketScores
    );

    const twinResult = await CareerDigitalTwinEngine.simulate(
      careerResult,
      roiResult,
      cognitiveResult,
      academicResult,
      marketScores
    );

    let skillResult = {
      skills: [],
      roadmap: [],
      top_career: careerResult?.top_careers?.[0]?.career ?? null,
      recommended_stream: streamResult.recommended_stream,
      engine_version: '1.0.0',
    };

    try {
      skillResult = await skillEvolutionService.generateRecommendations(
        studentId,
        {
          careerResult,
          streamResult,
          cognitiveResult,
        }
      );
    } catch (error) {
      logger.warn(
        { studentId, err: error.message },
        '[EduOrchestrator] Skill Evolution fallback activated'
      );
    }

    // ───────────────────────────────────────────────────────────────────────
    // 11) Persist outputs in parallel using atomic SQL RPC
    // ───────────────────────────────────────────────────────────────────────
    const streamWritePromise = supabase
      .from(TABLES.STREAM_SCORES)
      .upsert(
        {
          student_id: studentId,
          engineering_score: streamResult.stream_scores?.engineering ?? null,
          medical_score: streamResult.stream_scores?.medical ?? null,
          commerce_score: streamResult.stream_scores?.commerce ?? null,
          humanities_score: streamResult.stream_scores?.humanities ?? null,
          recommended_stream: streamResult.recommended_stream,
          recommended_label: streamResult.recommended_label,
          confidence: streamResult.confidence,
          alternative_stream: streamResult.alternative_stream,
          alternative_label: streamResult.alternative_label,
          rationale: streamResult.rationale,
          engine_version: ENGINE_VERSION,
        },
        { onConflict: 'student_id' }
      );

    const careerRows = (careerResult.top_careers || []).map((item) => ({
      career_name: item.career,
      success_probability: item.probability,
    }));

    const roiRows = (roiResult.education_options || []).map((option) => ({
      education_path: option.path,
      duration_years: option.duration_years,
      estimated_cost: option.estimated_cost,
      expected_salary: option.expected_salary,
      roi_score: option.roi_score,
      roi_level: option.roi_level,
      matched_careers: option.matched_careers,
    }));

    const simulationRows = (twinResult.simulations || []).map((sim) => ({
      career_name: sim.career,
      probability: sim.probability,
      entry_salary: sim.entry_salary,
      salary_3_year: sim.salary_3_year,
      salary_5_year: sim.salary_5_year,
      salary_10_year: sim.salary_10_year,
      annual_growth_rate: sim.annual_growth_rate,
      demand_level: sim.demand_level,
      roi_level: sim.roi_level,
      best_education_path: sim.best_education_path,
      milestones: sim.milestones,
    }));

    const [
      streamUpsertResponse,
      careerInserted,
      roiInserted,
      simulationInserted,
    ] = await Promise.all([
      streamWritePromise,
      atomicReplace('replace_career_predictions', studentId, careerRows),
      atomicReplace('replace_education_roi', studentId, roiRows),
      atomicReplace('replace_career_simulations', studentId, simulationRows),
    ]);

    logNonFatalWrite(
      TABLES.STREAM_SCORES,
      studentId,
      streamUpsertResponse.error
    );

    logger.info(
      {
        studentId,
        careerInserted,
        roiInserted,
        simulationInserted,
      },
      '[EduOrchestrator] Persistence summary'
    );

    const elapsed = Date.now() - startedAt;

    logger.info(
      {
        studentId,
        elapsed,
        recommended: streamResult.recommended_stream,
      },
      '[EduOrchestrator] Pipeline complete'
    );

    return {
      academic: academicResult,
      cognitive: cognitiveResult,
      activity: activityResult,
      stream: streamResult,
      careers: careerResult,
      roi: roiResult,
      twin: twinResult,
      skills: skillResult,
    };
  } catch (error) {
    logger.error(
      { studentId, err: error.message },
      '[EduOrchestrator] Pipeline failed'
    );
    throw error;
  }
}

module.exports = { run };