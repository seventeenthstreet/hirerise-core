'use strict';

// CONTRACT NOTE (Phase 2): All error responses use V2 canonical shape.


const { supabase } = require('../../../config/supabase');
const logger = require('../../../utils/logger');
const educationIntelligenceService = require('../../../services/educationIntelligence.service');
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
 * Atomic UPSERT for simulations.
 * Requires UNIQUE(student_id, career_name)
 */
async function replaceCareerSimulations(studentId, simulations) {
  const rows = simulations.map((sim) => ({
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
    milestones: sim.milestones ?? []
  }));

  const { error } = await supabase
    .from(COLLECTIONS.CAREER_SIMULATIONS)
    .upsert(rows, {
      onConflict: 'student_id,career_name'
    });

  if (error) {
    logger.error(
      {
        studentId,
        error: error.message
      },
      '[SimulationController] Failed to persist simulations'
    );
    throw error;
  }
}

async function simulateCareers(req, res, next) {
  try {
    const requestingUserId = getAuthenticatedUserId(req);
    const studentId = req.params?.studentId;

    if (!isValidStudentId(studentId)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_STUDENT_ID',
          message: 'studentId path parameter must be a non-empty string.',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    if (requestingUserId !== studentId && !isAdmin(req)) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'You may only request simulations for your own profile.',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    logger.info(
      { studentId, requestingUserId },
      '[SimulationController] Simulation requested'
    );

    const { student, cognitive, streamScores } =
      await educationIntelligenceService.getStudentContext(studentId);

    if (!student) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'STUDENT_NOT_FOUND',
          message: 'Student profile not found. Complete onboarding first.',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    if (!cognitive) {
      return res.status(422).json({
        success: false,
        error: {
          code: 'COGNITIVE_MISSING',
          message: 'Complete the cognitive assessment before running simulations.',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    const recommendedStream =
      streamScores?.recommended_stream ?? 'engineering';

    const context = {
      studentId,
      student,
      cognitive
    };

    const { twinResult } = await educationIntelligenceService.simulateCareers(
      context,
      recommendedStream
    );

    await replaceCareerSimulations(
      studentId,
      twinResult.simulations
    );

    logger.info(
      {
        studentId,
        count: twinResult.simulations.length
      },
      '[SimulationController] Simulations stored'
    );

    return res.status(200).json({
      success: true,
      data: {
        simulations: twinResult.simulations
      }
    });
  } catch (error) {
    logger.error(
      {
        studentId: req.params?.studentId,
        error: error.message
      },
      '[SimulationController] Simulation failed'
    );

    return next(error);
  }
}

async function getSimulations(req, res, next) {
  try {
    const requestingUserId = getAuthenticatedUserId(req);
    const studentId = req.params?.studentId;

    if (!isValidStudentId(studentId)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_STUDENT_ID',
          message: 'studentId path parameter must be a non-empty string.',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    if (requestingUserId !== studentId && !isAdmin(req)) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'You may only view your own simulations.',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    const { data, error } = await supabase
      .from(COLLECTIONS.CAREER_SIMULATIONS)
      .select(`
        career_name,
        probability,
        entry_salary,
        salary_3_year,
        salary_5_year,
        salary_10_year,
        annual_growth_rate,
        demand_level,
        roi_level,
        best_education_path,
        milestones
      `)
      .eq('student_id', studentId)
      .order('salary_10_year', { ascending: false });

    if (error) throw error;

    if (!data?.length) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'SIMULATIONS_NOT_FOUND',
          message: 'No simulations found. Run analysis first.',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        simulations: data.map((d) => ({
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
        }))
      }
    });
  } catch (error) {
    logger.error(
      {
        studentId: req.params?.studentId,
        error: error.message
      },
      '[SimulationController] Fetch failed'
    );

    return next(error);
  }
}

module.exports = {
  simulateCareers,
  getSimulations
};