'use strict';

/**
 * @file src/domain/professionalProfile/__tests__/professionalProfile.validation.js
 *
 * WP-PRO-07 — Validation script (mocked, no live Supabase / no test runner
 * dependency), following the same methodology WP-PRO-06B used: "Mocked
 * unit-level execution ... with a stub `supabase` client that records every
 * `.from(table).update/upsert(payload)` call."
 *
 * Run with: node src/domain/professionalProfile/__tests__/professionalProfile.validation.js
 *
 * This intentionally does NOT use jest — this environment has no installed
 * node_modules (package.json declares jest as a devDependency, but it is not
 * present on disk here) — so this is a plain Node script with hand-rolled
 * assertions, runnable with just the `node` binary already on PATH.
 */

const assert = require('assert');
const Module = require('module');
const path = require('path');

let failures = 0;
let passed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL - ${name}`);
    console.error(`         ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock config/supabase, utils/logger, and lib/db/authoritativeMutation BEFORE
// professionalProfile.repository.js is ever required, so the real
// @supabase/supabase-js package (not installed in this environment) is never
// touched, and every write is captured for inspection instead of hitting a
// network call.
// ─────────────────────────────────────────────────────────────────────────────

const writeLog = [];
let mockRow = null; // what the "DB" currently has for readRow()

function resetMockRow(row) {
  mockRow = row;
}

function makeSupabaseStub() {
  return {
    from(table) {
      return {
        select() {
          return {
            eq(_col, _val) {
              return {
                async maybeSingle() {
                  return { data: mockRow, error: null };
                },
              };
            },
          };
        },
        upsert(payload, opts) {
          writeLog.push({ table, payload, opts });
          // Merge into mockRow so a subsequent readRow() sees this write —
          // mirrors real Postgres upsert-then-read semantics closely enough
          // for this validation's purposes.
          mockRow = { ...(mockRow || {}), ...payload };
          return Promise.resolve({ data: [payload], error: null });
        },
      };
    },
  };
}

const supabaseStub = makeSupabaseStub();
const loggerStub = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
};

function injectMockModule(resolvedPath, exportsValue) {
  const fakeModule = new Module(resolvedPath, null);
  fakeModule.exports = exportsValue;
  fakeModule.loaded = true;
  require.cache[resolvedPath] = fakeModule;
}

const repoDir = __dirname;
injectMockModule(path.resolve(repoDir, '../../../config/supabase.js'), { supabase: supabaseStub });
injectMockModule(path.resolve(repoDir, '../../../utils/logger.js'), loggerStub);
injectMockModule(
  path.resolve(repoDir, '../../../lib/db/authoritativeMutation.js'),
  {
    authoritativeUpsert: async ({ table, payload, conflictKey }) => {
      writeLog.push({ table, payload, conflictKey, via: 'authoritativeUpsert' });
      mockRow = { ...(mockRow || {}), ...payload };
      return payload;
    },
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Now safe to require the modules under test.
// ─────────────────────────────────────────────────────────────────────────────

const normalizer = require('../professionalProfile.normalizer');
const { emptyProfessionalProfile, PROFILE_SECTIONS } = require('../professionalProfile.schema');
const repository = require('../professionalProfile.repository');

console.log('WP-PRO-07 Professional Profile Normalization Engine — Validation\n');

// ─────────────────────────────────────────────────────────────────────────────
// 1. Normalizer: missing information stays incomplete, never invented
// ─────────────────────────────────────────────────────────────────────────────
console.log('1. Normalizer — missing data stays absent (Task 3)');

check('normalizePersonalInformation returns only supplied fields', () => {
  const result = normalizer.normalizePersonalInformation({ fullName: 'Ada Lovelace' });
  assert.deepStrictEqual(result[PROFILE_SECTIONS.PERSONAL_INFORMATION], { fullName: 'Ada Lovelace' });
});

check('normalizePersonalInformation returns {} for empty input (no invented values)', () => {
  const result = normalizer.normalizePersonalInformation({});
  assert.deepStrictEqual(result, {});
});

check('normalizeEducation on empty resume section produces empty array, not fabricated entries', () => {
  const result = normalizer.normalizeEducation([]);
  assert.deepStrictEqual(result[PROFILE_SECTIONS.EDUCATION], []);
});

check('normalizeExperience passes through only known fields, drops undefined ones', () => {
  const result = normalizer.normalizeExperience([{ role: 'Engineer', company: 'Acme' }]);
  assert.deepStrictEqual(result[PROFILE_SECTIONS.EXPERIENCE], [{ title: 'Engineer', company: 'Acme' }]);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Normalizer: Resume Upload composite (Task 3)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n2. Normalizer — Resume Upload composite (Task 3)');

const sampleHireRiseResume = {
  resumeId: 'resume-123',
  core: {
    fullName: 'Grace Hopper',
    email: 'grace@example.com',
    phone: '555-0100',
    location: 'New York, USA',
    title: 'Software Engineer',
    summary: 'Compiler pioneer.',
  },
  skills: [{ name: 'COBOL' }, { name: 'Leadership' }],
  experience: [
    { role: 'Software Engineer', company: 'Navy', startDate: '1959-01', endDate: null, current: true, type: 'job' },
  ],
  education: [
    { degree: 'PhD Mathematics', institution: 'Yale', startYear: 1930, endYear: 1934 },
  ],
  additionalSections: [
    { title: 'Certifications', items: [{ name: 'COBOL Certified' }] },
    { title: 'Projects', items: [{ name: 'COBOL Compiler' }] },
  ],
  metadata: {
    parsingConfidence: 0.92,
    completenessScore: 0.8,
    missingFields: [],
    detectedDomain: 'software_engineering',
    schemaVersion: '1.0.0',
    parsedAt: '2026-07-12T00:00:00.000Z',
  },
};

check('normalizeResumeUpload produces all expected sections', () => {
  const partial = normalizer.normalizeResumeUpload(sampleHireRiseResume, {
    resumeId: 'resume-123',
    fileUrl: 'https://example.com/resume.pdf',
    parserVersion: '2.0.0',
  });

  assert.strictEqual(partial[PROFILE_SECTIONS.PERSONAL_INFORMATION].fullName, 'Grace Hopper');
  assert.strictEqual(partial[PROFILE_SECTIONS.EDUCATION].length, 1);
  assert.strictEqual(partial[PROFILE_SECTIONS.EXPERIENCE].length, 1);
  assert.strictEqual(partial[PROFILE_SECTIONS.SKILLS].length, 2);
  assert.strictEqual(partial[PROFILE_SECTIONS.CERTIFICATIONS].length, 1);
  assert.strictEqual(partial[PROFILE_SECTIONS.PROJECTS].length, 1);
  assert.strictEqual(partial[PROFILE_SECTIONS.RESUME_METADATA].resumeId, 'resume-123');
  assert.strictEqual(partial[PROFILE_SECTIONS.RESUME_METADATA].parsingConfidence, 0.92);
  assert.strictEqual(
    partial[PROFILE_SECTIONS.COMPLETION_METADATA].acquisitionMethod,
    'resume_upload'
  );
});

check('normalizeResumeUpload never populates careerIntelligenceMetadata (boundary rule)', () => {
  const partial = normalizer.normalizeResumeUpload(sampleHireRiseResume, {});
  assert.strictEqual(partial[PROFILE_SECTIONS.CAREER_INTELLIGENCE_METADATA], undefined);
});

check('normalizeResumeUpload on a resume with empty experience/education stays empty (no fabrication)', () => {
  const sparse = { ...sampleHireRiseResume, experience: [], education: [] };
  const partial = normalizer.normalizeResumeUpload(sparse, {});
  assert.deepStrictEqual(partial[PROFILE_SECTIONS.EXPERIENCE], []);
  assert.deepStrictEqual(partial[PROFILE_SECTIONS.EDUCATION], []);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Normalizer: merge semantics
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n3. Normalizer — merge semantics');

check('mergeProfileSections shallow-merges object sections without erasing other fields', () => {
  const base = emptyProfessionalProfile('user-1');
  base.personalInformation.fullName = 'Existing Name';

  const merged = normalizer.mergeProfileSections(base, {
    [PROFILE_SECTIONS.PERSONAL_INFORMATION]: { email: 'new@example.com' },
  });

  assert.strictEqual(merged.personalInformation.fullName, 'Existing Name');
  assert.strictEqual(merged.personalInformation.email, 'new@example.com');
});

check('mergeProfileSections wholesale-replaces repeatable sections', () => {
  const base = emptyProfessionalProfile('user-1');
  base.education = [{ degree: 'Old Degree' }];

  const merged = normalizer.mergeProfileSections(base, {
    [PROFILE_SECTIONS.EDUCATION]: [{ degree: 'New Degree' }],
  });

  assert.deepStrictEqual(merged.education, [{ degree: 'New Degree' }]);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Repository: acquisition-writable boundary rule (WP-PRO-04 §5)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n4. Repository — Career Intelligence Metadata boundary rule');

async function testBoundaryRule() {
  resetMockRow({ id: 'user-1', professional_profile: {} });
  writeLog.length = 0;

  await repository.saveProfessionalProfileSections('user-1', {
    [PROFILE_SECTIONS.PERSONAL_INFORMATION]: { fullName: 'Test User' },
    [PROFILE_SECTIONS.CAREER_INTELLIGENCE_METADATA]: { chiScore: 999 }, // must be rejected
  }, { source: 'test' });

  const write = writeLog.find(w => w.table === 'user_profiles');
  assert.ok(write, 'expected a write to user_profiles');
  assert.strictEqual(write.payload.display_name, 'Test User');
  assert.strictEqual(
    write.payload.professional_profile?.careerIntelligenceMetadata,
    undefined,
    'careerIntelligenceMetadata must never be written by an acquisition-facing call'
  );
}

async function testJsonbOnlySectionsMergeWithoutClobbering() {
  resetMockRow({
    id: 'user-1',
    professional_profile: {
      education: [{ degree: 'Existing Degree' }],
      careerIntelligenceMetadata: { chiScore: 72 }, // simulates a prior CHI write
    },
  });
  writeLog.length = 0;

  await repository.saveProfessionalProfileSections('user-1', {
    [PROFILE_SECTIONS.PROJECTS]: [{ name: 'New Project' }],
  }, { source: 'test' });

  const write = writeLog[writeLog.length - 1];
  assert.deepStrictEqual(write.payload.professional_profile.education, [{ degree: 'Existing Degree' }]);
  assert.deepStrictEqual(write.payload.professional_profile.projects, [{ name: 'New Project' }]);
  assert.deepStrictEqual(
    write.payload.professional_profile.careerIntelligenceMetadata,
    { chiScore: 72 },
    'a prior Career Intelligence write must survive an unrelated acquisition-method write'
  );
}

async function testDedicatedColumnsNotDuplicatedInJsonb() {
  resetMockRow({ id: 'user-1', professional_profile: {} });
  writeLog.length = 0;

  await repository.saveProfessionalProfileSections('user-1', {
    [PROFILE_SECTIONS.SKILLS]: [{ name: 'JavaScript', source: 'declared' }],
    [PROFILE_SECTIONS.EXPERIENCE]: [{ title: 'Engineer', company: 'Acme' }],
  }, { source: 'test' });

  const write = writeLog[writeLog.length - 1];
  assert.deepStrictEqual(write.payload.skills, [{ name: 'JavaScript', source: 'declared' }]);
  assert.deepStrictEqual(write.payload.experience, [{ title: 'Engineer', company: 'Acme' }]);
  assert.strictEqual(
    write.payload.professional_profile,
    undefined,
    'skills/experience have dedicated columns and must not also be duplicated into the jsonb blob'
  );
}

async function testGetProfessionalProfileComposesFullShape() {
  resetMockRow({
    id: 'user-1',
    display_name: 'Composed User',
    email: 'composed@example.com',
    current_city: 'Bengaluru',
    current_job_title: 'Engineer',
    current_company: 'Acme',
    work_authorisation: 'Citizen',
    skills: [{ name: 'Go' }],
    experience: [{ title: 'Engineer', company: 'Acme' }],
    languages: [{ name: 'English' }],
    expected_role_ids: ['role-1'],
    target_role: 'Staff Engineer',
    work_mode: 'remote',
    preferred_work_location: 'Bengaluru',
    expected_salary_lpa: 40,
    job_search_timeline: 'immediately',
    latest_resume_id: 'resume-9',
    professional_profile: {
      education: [{ degree: 'BSc CS' }],
      projects: [{ name: 'Compiler' }],
      certifications: [{ name: 'AWS' }],
      personalInformation: { phone: '555-0000' },
      resumeMetadata: { parsingConfidence: 0.7 },
      careerIntelligenceMetadata: { chiScore: 81 },
    },
  });

  const profile = await repository.getProfessionalProfile('user-1');
  assert.strictEqual(profile.personalInformation.fullName, 'Composed User');
  assert.strictEqual(profile.personalInformation.phone, '555-0000');
  assert.strictEqual(profile.education.length, 1);
  assert.strictEqual(profile.experience.length, 1);
  assert.strictEqual(profile.skills.length, 1);
  assert.strictEqual(profile.projects.length, 1);
  assert.strictEqual(profile.certifications.length, 1);
  assert.strictEqual(profile.careerGoals.targetRole, 'Staff Engineer');
  assert.strictEqual(profile.employmentPreferences.workMode, 'remote');
  assert.strictEqual(profile.resumeMetadata.resumeId, 'resume-9');
  assert.strictEqual(profile.resumeMetadata.parsingConfidence, 0.7);
  assert.strictEqual(profile.careerIntelligenceMetadata.chiScore, 81);
}

async function testEmptyPartialProfileIsANoOp() {
  resetMockRow({ id: 'user-1', professional_profile: {} });
  writeLog.length = 0;

  const result = await repository.saveProfessionalProfileSections('user-1', {}, { source: 'test' });
  assert.strictEqual(result.written, false);
  assert.strictEqual(writeLog.length, 0, 'no DB write should occur for an empty partial profile');
}

(async () => {
  console.log();
  for (const [name, fn] of [
    ['boundary rule strips careerIntelligenceMetadata', testBoundaryRule],
    ['jsonb-only sections merge without clobbering sibling keys', testJsonbOnlySectionsMergeWithoutClobbering],
    ['dedicated-column sections are not duplicated into jsonb', testDedicatedColumnsNotDuplicatedInJsonb],
    ['getProfessionalProfile composes the full canonical shape', testGetProfessionalProfileComposesFullShape],
    ['empty partial profile performs zero writes', testEmptyPartialProfileIsANoOp],
  ]) {
    try {
      await fn();
      passed += 1;
      console.log(`  ok - ${name}`);
    } catch (err) {
      failures += 1;
      console.error(`  FAIL - ${name}`);
      console.error(`         ${err.stack}`);
    }
  }

  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
})();
