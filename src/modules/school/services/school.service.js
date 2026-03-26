'use strict';

const { v4: uuidv4 } = require('uuid');
const logger = require('../../../utils/logger');
const supabase = require('../../../config/supabase');
const { createClient } = require('@supabase/supabase-js');

const schoolRepo = require('../repositories/school.repository');
const { SCHOOL_ROLES } = require('../models/school.model');
const { COLLECTIONS: EDU_COLLECTIONS } = require('../../education-intelligence/models/student.model');
const studentRepo = require('../../education-intelligence/repositories/student.repository');
const orchestrator = require('../../education-intelligence/orchestrator/education.orchestrator');
const { parseCSVBuffer } = require('../../admin/import/csvParser.util');

// ─── Supabase Admin Client ─────────────────────────────

let _admin = null;
function getAdmin() {
  if (_admin) return _admin;

  _admin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  return _admin;
}

// ─── School CRUD ───────────────────────────────────────

async function createSchool(userId, fields) {
  if (!fields.school_name) {
    throw new Error('school_name is required');
  }

  const school = await schoolRepo.createSchool(userId, {
    school_name: fields.school_name.trim(),
    location: (fields.location || '').trim(),
  });

  await schoolRepo.addSchoolUser(school.id, userId, SCHOOL_ROLES.ADMIN);

  return { school };
}

async function getSchool(schoolId) {
  const school = await schoolRepo.getSchool(schoolId);
  if (!school) throw new Error('School not found');
  return { school };
}

async function getMySchools(userId) {
  const schools = await schoolRepo.getSchoolsForUser(userId);
  return { schools };
}

// ─── Counselor ─────────────────────────────────────────

async function addCounselor(schoolId, email) {
  const { data } = await getAdmin().auth.admin.listUsers();

  const user = data.users.find(u => u.email === email);

  if (!user) throw new Error('User not found');

  const membership = await schoolRepo.addSchoolUser(
    schoolId,
    user.id,
    SCHOOL_ROLES.COUNSELOR
  );

  return { membership, user };
}

async function getCounselors(schoolId) {
  const members = await schoolRepo.getSchoolUsers(schoolId);
  return { counselors: members.filter(m => m.role === SCHOOL_ROLES.COUNSELOR) };
}

// ─── Students ──────────────────────────────────────────

async function listStudents(schoolId) {
  const links = await schoolRepo.getSchoolStudentIds(schoolId);
  if (!links.length) return { students: [] };

  const ids = links.map(l => l.student_id);

  const { data, error } = await supabase
    .from(EDU_COLLECTIONS.STUDENTS)
    .select('*')
    .in('id', ids);

  if (error) throw error;

  const students = links.map(link => {
    const s = data.find(d => d.id === link.student_id) || {};

    return {
      link_id: link.link_id,
      student_id: link.student_id,
      class: link.class,
      section: link.section,
      name: s.name || 'Unknown',
      email: s.email || null,
      education_level: s.education_level || null,
      onboarding_step: s.onboarding_step || null,
      assessment_done: false,
    };
  });

  return { students };
}

// ─── CSV Import ────────────────────────────────────────

async function importStudentsCSV(schoolId, fileBuffer) {
  const rows = parseCSVBuffer(fileBuffer);
  const results = { imported: 0, skipped: 0, errors: [], students: [] };

  for (const row of rows) {
    const name = row.name?.trim();
    const email = row.email?.trim().toLowerCase();

    if (!name || !email) {
      results.skipped++;
      continue;
    }

    try {
      const { data } = await getAdmin().auth.admin.listUsers();
      let user = data.users.find(u => u.email === email);

      if (!user) {
        const { data: created } = await getAdmin().auth.admin.createUser({
          email,
          password: uuidv4() + 'Aa1!',
        });
        user = created.user;
      }

      await studentRepo.upsertStudent(user.id, { name, email });
      await schoolRepo.addStudentToSchool(schoolId, user.id, {});

      results.imported++;
      results.students.push({ name, email });

    } catch (err) {
      results.skipped++;
      results.errors.push({ email, reason: err.message });
    }
  }

  return results;
}

// ─── Assessment ────────────────────────────────────────

async function runAssessment(schoolId, studentId) {
  const ok = await schoolRepo.isStudentInSchool(schoolId, studentId);
  if (!ok) throw new Error('Not allowed');

  const result = await orchestrator.run(studentId);
  return { result };
}

// ─── Report ────────────────────────────────────────────

async function getStudentReport(schoolId, studentId) {
  const ok = await schoolRepo.isStudentInSchool(schoolId, studentId);
  if (!ok) throw new Error('Not allowed');

  const { data, error } = await supabase
    .from(EDU_COLLECTIONS.STUDENTS)
    .select('*')
    .eq('id', studentId)
    .single();

  if (error) throw error;

  return {
    student: data,
    generated_at: new Date().toISOString(),
  };
}

// ─── Analytics ─────────────────────────────────────────

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