'use strict';

/**
 * controllers/careerSimulation.controller.js
 *
 * POST /api/v1/education/career-simulation/:studentId  — run CDTE, store + return
 * GET  /api/v1/education/career-simulation/:studentId  — return stored simulations
 */
const supabase = require('../../../core/supabaseClient');
const logger = require('../../../utils/logger');
const repository = require('../repositories/student.repository');
const CareerSuccessEngine = require('../engines/careerSuccess.engine');
const EducationROIEngine = require('../engines/educationROI.engine');
const CareerDigitalTwinEngine = require('../engines/careerDigitalTwin.engine');
const { COLLECTIONS } = require('../models/student.model');

// ─── POST ─────────────────────────────────────────────────────────────────────

async function simulateCareers(req, res, next) {
  try {
    const requestingUid = req.user.uid;
    const studentId = req.params.studentId;
    if (requestingUid !== studentId && !req.user.admin) {
      return res.status(403).json({
        success: false,
        errorCode: 'FORBIDDEN',
        message: 'You may only request simulations for your own profile.'
      });
    }
    logger.info({ studentId }, '[SimulationController] Simulation requested');

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
        message: 'Complete the cognitive assessment before running simulations.'
      });
    }

    const recommendedStream = streamScores?.recommended_stream ?? 'engineering';
    const context = { studentId, student, cognitive };

    // Run dependency engines
    const careerResult = await CareerSuccessEngine.analyze(context, recommendedStream);
    const roiResult = await EducationROIEngine.analyze(careerResult, recommendedStream);

    // Build lightweight cognitive/academic proxies from stored scores
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

    // Persist (replace previous) — delete existing rows then bulk insert
    const now = new Date().toISOString();

    await supabase
      .from(COLLECTIONS.CAREER_SIMULATIONS)
      .delete()
      .eq('student_id', studentId);

    const simulationsToInsert = twinResult.simulations.map(sim => ({
      student_id: studentId,
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
      created_at: now
    }));

    if (simulationsToInsert.length > 0) {
      const { error: insertError } = await supabase
        .from(COLLECTIONS.CAREER_SIMULATIONS)
        .insert(simulationsToInsert);
      if (insertError) throw insertError;
    }

    logger.info(
      { studentId, count: twinResult.simulations.length },
      '[SimulationController] Simulations stored'
    );
    return res.status(200).json({
      success: true,
      data: { simulations: twinResult.simulations }
    });
  } catch (err) {
    next(err);
  }
}

// ─── GET ──────────────────────────────────────────────────────────────────────

async function getSimulations(req, res, next) {
  try {
    const requestingUid = req.user.uid;
    const studentId = req.params.studentId;
    if (requestingUid !== studentId && !req.user.admin) {
      return res.status(403).json({
        success: false,
        errorCode: 'FORBIDDEN',
        message: 'You may only view your own simulations.'
      });
    }

    const { data, error } = await supabase
      .from(COLLECTIONS.CAREER_SIMULATIONS)
      .select('career_name, probability, entry_salary, salary_3_year, salary_5_year, salary_10_year, annual_growth_rate, demand_level, roi_level, best_education_path, milestones')
      .eq('student_id', studentId)
      .order('salary_10_year', { ascending: false });

    if (error) throw error;

    if (!data || data.length === 0) {
      return res.status(404).json({
        success: false,
        errorCode: 'SIMULATIONS_NOT_FOUND',
        message: 'No simulations found. Run analysis first.'
      });
    }

    const simulations = data.map(d => ({
      career: d.career_name,
      probability: d.probability,
      entry_salary: d.entry_salary,
      salary_3_year: d.salary_3_year,
      salary_5_year: d.salary_5_year,
      salary_10_year: d.salary_10_year,
      annual_growth_rate: d.annual_growth_rate,
      demand_level: d.demand_level,
      roi_level: d.roi_level,
      best_education_path: d.best_education_path,
      milestones: d.milestones ?? []
    }));

    return res.status(200).json({
      success: true,
      data: { simulations }
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  simulateCareers,
  getSimulations
};