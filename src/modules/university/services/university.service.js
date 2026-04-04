'use strict';

/**
 * src/modules/university/services/university.service.js
 *
 * Production-ready university business layer
 * Fully Firebase-free
 * Supabase / SQL-safe orchestration
 */

const logger = require('../../../utils/logger');
const uniRepo = require('../repositories/university.repository');
const { UNIVERSITY_ROLES } = require('../models/university.model');
const matchingService = require('../../opportunities/services/studentMatching.service');

// ─────────────────────────────────────────────────────────────
// Error Helpers
// ─────────────────────────────────────────────────────────────

function createError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

const badRequest = (message) => createError(message, 400);
const notFound = (message) => createError(message, 404);

// ─────────────────────────────────────────────────────────────
// Internal Helpers
// ─────────────────────────────────────────────────────────────

async function ensureProgramOwnership(universityId, programId) {
  const program = await uniRepo.getProgram(programId);

  if (!program || program.university_id !== universityId) {
    throw notFound('Program not found in this university.');
  }

  return program;
}

// ─────────────────────────────────────────────────────────────
// University CRUD
// ─────────────────────────────────────────────────────────────

async function createUniversity(userId, fields) {
  if (!fields?.university_name?.trim()) {
    throw badRequest('university_name is required.');
  }

  let university = null;

  try {
    university = await uniRepo.createUniversity(userId, {
      university_name: fields.university_name.trim(),
      country: fields.country || null,
      website: fields.website || null,
    });

    await uniRepo.addUniversityUser(
      university.id,
      userId,
      UNIVERSITY_ROLES.ADMIN
    );

    return { university };

  } catch (err) {
    logger.error(
      { err: err.message, userId, universityId: university?.id },
      '[UniversityService] createUniversity'
    );

    /**
     * Compensating rollback
     * Prevents orphan university rows if membership insert fails.
     * Later best replaced with SQL RPC transaction.
     */
    if (university?.id) {
      try {
        await uniRepo.deleteUniversity?.(university.id);
      } catch (rollbackErr) {
        logger.error(
          {
            err: rollbackErr.message,
            universityId: university.id,
          },
          '[UniversityService] createUniversity rollback failed'
        );
      }
    }

    throw err;
  }
}

async function getMyUniversities(userId) {
  try {
    const universities = await uniRepo.getMyUniversities(userId);
    return { universities };
  } catch (err) {
    logger.error(
      { err: err.message, userId },
      '[UniversityService] getMyUniversities'
    );
    throw err;
  }
}

async function getUniversity(universityId) {
  try {
    const university = await uniRepo.getUniversity(universityId);

    if (!university) {
      throw notFound('University not found.');
    }

    return { university };
  } catch (err) {
    logger.error(
      { err: err.message, universityId },
      '[UniversityService] getUniversity'
    );
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────
// Program CRUD
// ─────────────────────────────────────────────────────────────

async function createProgram(universityId, fields) {
  if (!fields?.program_name?.trim()) {
    throw badRequest('program_name is required.');
  }

  try {
    const program = await uniRepo.createProgram(universityId, {
      program_name: fields.program_name.trim(),
      degree_type: fields.degree_type || null,
      duration_years: fields.duration_years,
      tuition_cost: fields.tuition_cost,
      streams: Array.isArray(fields.streams) ? fields.streams : [],
      career_outcomes: Array.isArray(fields.career_outcomes)
        ? fields.career_outcomes
        : [],
    });

    return { program };
  } catch (err) {
    logger.error(
      { err: err.message, universityId },
      '[UniversityService] createProgram'
    );
    throw err;
  }
}

async function listPrograms(universityId) {
  try {
    const programs = await uniRepo.listPrograms(universityId);
    return { programs };
  } catch (err) {
    logger.error(
      { err: err.message, universityId },
      '[UniversityService] listPrograms'
    );
    throw err;
  }
}

async function updateProgram(universityId, programId, fields) {
  try {
    await ensureProgramOwnership(universityId, programId);
    const updated = await uniRepo.updateProgram(programId, fields);
    return { program: updated };
  } catch (err) {
    logger.error(
      { err: err.message, universityId, programId },
      '[UniversityService] updateProgram'
    );
    throw err;
  }
}

async function deleteProgram(universityId, programId) {
  try {
    await ensureProgramOwnership(universityId, programId);
    await uniRepo.deleteProgram(programId);
    return { deleted: true };
  } catch (err) {
    logger.error(
      { err: err.message, universityId, programId },
      '[UniversityService] deleteProgram'
    );
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────
// Analytics
// ─────────────────────────────────────────────────────────────

async function getAnalytics(universityId) {
  try {
    const { programs } = await listPrograms(universityId);

    if (!programs.length) {
      return {
        university_id: universityId,
        total_programs: 0,
        total_matched_students: 0,
        programs: [],
      };
    }

    const programStats = await Promise.all(
      programs.map(async (program) => {
        try {
          const stats =
            await matchingService.getMatchedStudentsForProgram(program.id);

          return {
            program_id: program.id,
            program_name: program.program_name,
            degree_type: program.degree_type,
            matched_count: stats?.total_matched || 0,
            avg_score: stats?.avg_match_score || 0,
            top_skills: (stats?.top_student_skills || []).slice(0, 5),
          };
        } catch (err) {
          logger.warn(
            { err: err.message, programId: program.id },
            '[UniversityService] analytics per-program failed'
          );

          return {
            program_id: program.id,
            program_name: program.program_name,
            degree_type: program.degree_type,
            matched_count: 0,
            avg_score: 0,
            top_skills: [],
          };
        }
      })
    );

    const totalMatched = programStats.reduce(
      (sum, p) => sum + p.matched_count,
      0
    );

    return {
      university_id: universityId,
      total_programs: programs.length,
      total_matched_students: totalMatched,
      programs: programStats.sort((a, b) => b.matched_count - a.matched_count),
    };
  } catch (err) {
    logger.error(
      { err: err.message, universityId },
      '[UniversityService] getAnalytics'
    );
    throw err;
  }
}

module.exports = {
  createUniversity,
  getMyUniversities,
  getUniversity,
  createProgram,
  listPrograms,
  updateProgram,
  deleteProgram,
  getAnalytics,
};