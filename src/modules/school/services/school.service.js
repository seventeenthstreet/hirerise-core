'use strict';

const { v4: uuidv4 } = require('uuid');
const { createClient } = require('@supabase/supabase-js');

const logger = require('../../../utils/logger');
const { supabase } = require('../../../config/supabase');

const schoolRepo = require('../repositories/school.repository');
const { SCHOOL_ROLES } = require('../models/school.model');

const {
  TABLES: EDU_TABLES,
} = require('../../education-intelligence/models/student.model');

const studentRepo = require('../../education-intelligence/repositories/student.repository');
const orchestrator = require('../../education-intelligence/orchestrator/education.orchestrator');
const { parseCSVBuffer } = require('../../admin/import/csvParser.util');

/* ──────────────────────────────────────────────────────────────
 * Shared admin client singleton
 * ────────────────────────────────────────────────────────────── */
let _admin = null;

function getAdmin() {
  if (_admin) return _admin;

  _admin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    }
  );

  return _admin;
}

/* ──────────────────────────────────────────────────────────────
 * Schools
 * ────────────────────────────────────────────────────────────── */
async function createSchool(userId, fields) {
  if (!fields?.school_name?.trim()) {
    throw new Error('school_name is required');
  }

  const school = await schoolRepo.createSchool(userId, {
    school_name: fields.school_name,
    location: fields.location || null,
  });

  await schoolRepo.addSchoolUser(
    school.id,
    userId,
    SCHOOL_ROLES.ADMIN
  );

  return { school };
}

async function getSchool(schoolId) {
  const school = await schoolRepo.getSchool(schoolId);

  if (!school) {
    const err = new Error('School not found');
    err.statusCode = 404;
    throw err;
  }

  return { school };
}

async function getMySchools(userId) {
  const schools = await schoolRepo.getSchoolsForUser(userId);
  return { schools };
}

/* ──────────────────────────────────────────────────────────────
 * Counselors
 * ────────────────────────────────────────────────────────────── */
async function addCounselor(schoolId, email) {
  const normalizedEmail = email?.trim().toLowerCase();

  const { data, error } = await getAdmin().auth.admin.listUsers();

  if (error) throw error;

  const user = data.users.find(
    u => u.email?.toLowerCase() === normalizedEmail
  );

  if (!user) {
    const err = new Error('User not found');
    err.statusCode = 404;
    throw err;
  }

  const membership = await schoolRepo.addSchoolUser(
    schoolId,
    user.id,
    SCHOOL_ROLES.COUNSELOR
  );

  return { membership, user };
}

async function getCounselors(schoolId) {
  const members = await schoolRepo.getSchoolUsers(schoolId);

  return {
    counselors: members.filter(
      member => member.role === SCHOOL_ROLES.COUNSELOR
    ),
  };
}

/* ──────────────────────────────────────────────────────────────
 * Students
 * ────────────────────────────────────────────────────────────── */
async function listStudents(schoolId) {
  const links = await schoolRepo.getSchoolStudentIds(schoolId);
  if (!links.length) return { students: [] };

  const ids = links.map(link => link.student_id);

  const { data, error } = await supabase
    .from(EDU_TABLES.STUDENTS)
    .select('*')
    .in('id', ids);

  if (error) throw error;

  const studentMap = new Map(
    (data || []).map(student => [student.id, student])
  );

  const students = links.map(link => {
    const student = studentMap.get(link.student_id) || {};

    return {
      link_id: link.link_id,
      student_id: link.student_id,
      class: link.class,
      section: link.section,
      name: student.name || 'Unknown',
      email: student.email || null,
      education_level: student.education_level || null,
      onboarding_step: student.onboarding_step || null,
      assessment_done: false,
    };
  });

  return { students };
}

/* ──────────────────────────────────────────────────────────────
 * CSV import
 * ────────────────────────────────────────────────────────────── */
async function importStudentsCSV(schoolId, fileBuffer) {
  const rows = parseCSVBuffer(fileBuffer);
  const results = {
    imported: 0,
    skipped: 0,
    errors: [],
    students: [],
  };

  const { data: userList, error } = await getAdmin().auth.admin.listUsers();

  if (error) throw error;

  const emailToUser = new Map(
    userList.users.map(user => [user.email?.toLowerCase(), user])
  );

  for (const row of rows) {
    const name = row.name?.trim();
    const email = row.email?.trim().toLowerCase();

    if (!name || !email) {
      results.skipped++;
      continue;
    }

    try {
      let user = emailToUser.get(email);

      if (!user) {
        const { data: created, error: createError } =
          await getAdmin().auth.admin.createUser({
            email,
            password: `${uuidv4()}Aa1!`,
          });

        if (createError) throw createError;

        user = created.user;
        emailToUser.set(email, user);
      }

      await studentRepo.upsertStudent(user.id, { name, email });
      await schoolRepo.addStudentToSchool(schoolId, user.id);

      results.imported++;
      results.students.push({ name, email });
    } catch (err) {
      logger.warn(
        { schoolId, email, err: err.message },
        '[SchoolService] import student failed'
      );

      results.skipped++;
      results.errors.push({
        email,
        reason: err.message,
      });
    }
  }

  return results;
}

/* ──────────────────────────────────────────────────────────────
 * Assessment
 * ────────────────────────────────────────────────────────────── */
async function runAssessment(schoolId, studentId) {
  const allowed = await schoolRepo.isStudentInSchool(
    schoolId,
    studentId
  );

  if (!allowed) {
    const err = new Error('Not allowed');
    err.statusCode = 403;
    throw err;
  }

  const result = await orchestrator.run(studentId);
  return { result };
}

/* ──────────────────────────────────────────────────────────────
 * Student report
 * ────────────────────────────────────────────────────────────── */
async function getStudentReport(schoolId, studentId) {
  const allowed = await schoolRepo.isStudentInSchool(
    schoolId,
    studentId
  );

  if (!allowed) {
    const err = new Error('Not allowed');
    err.statusCode = 403;
    throw err;
  }

  const { data, error } = await supabase
    .from(EDU_TABLES.STUDENTS)
    .select('*')
    .eq('id', studentId)
    .single();

  if (error) throw error;

  return {
    student: data,
    generated_at: new Date().toISOString(),
  };
}

/* ──────────────────────────────────────────────────────────────
 * Analytics
 * ────────────────────────────────────────────────────────────── */
async function getAnalytics(schoolId) {
  const links = await schoolRepo.getSchoolStudentIds(schoolId);

  return {
    total_students: links.length,
    students_assessed: 0,
    assessment_rate: 0,
    stream_distribution: [],
    top_careers: [],
  };
}

module.exports = {
  createSchool,
  getSchool,
  getMySchools,
  addCounselor,
  getCounselors,
  listStudents,
  importStudentsCSV,
  runAssessment,
  getStudentReport,
  getAnalytics,
};