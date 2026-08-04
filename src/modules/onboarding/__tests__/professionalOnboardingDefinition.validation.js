'use strict';

/**
 * @file src/modules/onboarding/__tests__/professionalOnboardingDefinition.validation.js
 *
 * WP-PRO-08 — Validation script (mocked, no live Supabase / no test runner
 * dependency), following the same methodology WP-PRO-06B/WP-PRO-07 used:
 * a stub `supabase` client injected into require.cache before the modules
 * under test are ever required, so the real `@supabase/supabase-js`
 * package (not installed in this environment) is never touched.
 *
 * Run with:
 *   node src/modules/onboarding/__tests__/professionalOnboardingDefinition.validation.js
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

// ─────────────────────────────────────────────────────────────────────────
// Mock config/supabase and utils/logger BEFORE onboarding.helpers.js (and
// therefore professional-onboarding.progression.js, which requires it) is
// ever required.
// ─────────────────────────────────────────────────────────────────────────

function makeSupabaseStub() {
  return {
    from() {
      return {
        select() {
          return {
            eq() {
              return { async maybeSingle() { return { data: null, error: null }; } };
            },
          };
        },
        upsert() {
          return Promise.resolve({ data: null, error: null });
        },
        update() {
          return { eq() { return Promise.resolve({ data: null, error: null }); } };
        },
      };
    },
  };
}

const loggerStub = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
};

function injectMockModule(resolvedPath, exportsValue) {
  const fakeModule = new Module(resolvedPath, null);
  fakeModule.exports = exportsValue;
  fakeModule.loaded = true;
  require.cache[resolvedPath] = fakeModule;
}

const testDir = __dirname;
injectMockModule(path.resolve(testDir, '../../../config/supabase.js'), { supabase: makeSupabaseStub() });
injectMockModule(path.resolve(testDir, '../../../utils/logger.js'), loggerStub);

// ─────────────────────────────────────────────────────────────────────────
// Now safe to require the modules under test.
// ─────────────────────────────────────────────────────────────────────────

const definition = require('../professional-onboarding.definition');
const progression = require('../professional-onboarding.progression');

console.log('WP-PRO-08 Professional Onboarding Definition Engine — Validation\n');

// ─────────────────────────────────────────────────────────────────────────
// 1. New user — the "0 of 0 steps" defect must be structurally impossible
// ─────────────────────────────────────────────────────────────────────────
console.log('1. New user (no progress row) — steps[] is never empty');

check('brand-new user sees exactly [consent], not an empty array', () => {
  const { steps, track, isComplete } = progression.buildSteps({
    completedSteps: [],
    progress: {},
    profile: {},
  });
  assert.deepStrictEqual(steps, [{ stepId: 'consent', completed: false }]);
  assert.strictEqual(track, null);
  assert.strictEqual(isComplete, false);
});

check('computeCurrentStep on a fresh steps[] returns "consent"', () => {
  const { steps } = progression.buildSteps({ completedSteps: [], progress: {}, profile: {} });
  assert.strictEqual(progression.computeCurrentStep(steps), 'consent');
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Consent done, no track chosen yet — method_choice surfaces
// ─────────────────────────────────────────────────────────────────────────
console.log('\n2. Consent done, no track chosen — routing decision is listed');

check('method_choice appears once consent is done and no track detected', () => {
  const { steps, track } = progression.buildSteps({
    completedSteps: ['consent_saved'],
    progress: {},
    profile: {},
  });
  assert.deepStrictEqual(steps, [
    { stepId: 'consent', completed: true },
    { stepId: 'method_choice', completed: false },
  ]);
  assert.strictEqual(track, null);
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Entry Method 1 — Resume Upload (WP-PRO-03C worked example, §8)
// ─────────────────────────────────────────────────────────────────────────
console.log('\n3. Entry Method 1 — Resume Upload track');

check('detectTrack recognizes cv_uploaded as RESUME_UPLOAD', () => {
  const track = progression.detectTrack(['consent_saved', 'cv_uploaded']);
  assert.strictEqual(track, definition.TRACKS.RESUME_UPLOAD);
});

check('no guided_* steps appear at all for the Resume Upload track', () => {
  const { steps } = progression.buildSteps({
    completedSteps: ['consent_saved', 'cv_uploaded'],
    progress: { confidence: { overall: 72 } },
    profile: {},
  });
  const ids = steps.map((s) => s.stepId);
  assert.ok(!ids.some((id) => id.startsWith('guided_')), 'guided_* steps must be hidden, not listed');
  assert.deepStrictEqual(ids, [
    'consent', 'upload_resume', 'ai_resume_parsing', 'profile_review',
    'career_report', 'cv_generation',
  ]);
});

check('ai_resume_parsing derives completion from confidence.overall > 0', () => {
  const { steps: withConfidence } = progression.buildSteps({
    completedSteps: ['consent_saved', 'cv_uploaded'],
    progress: { confidence: { overall: 55 } },
    profile: {},
  });
  const { steps: withoutConfidence } = progression.buildSteps({
    completedSteps: ['consent_saved', 'cv_uploaded'],
    progress: { confidence: { overall: 0 } },
    profile: {},
  });
  assert.strictEqual(withConfidence.find((s) => s.stepId === 'ai_resume_parsing').completed, true);
  assert.strictEqual(withoutConfidence.find((s) => s.stepId === 'ai_resume_parsing').completed, false);
});

check('profile_review derives completion from evaluateCompletion.trackAUpload', () => {
  const { steps } = progression.buildSteps({
    completedSteps: ['consent_saved', 'cv_uploaded'],
    progress: {
      confidence:       { overall: 80 },
      cv_resume_id:     'resume-abc',
      personal_details: { full_name: 'Ada Lovelace' },
    },
    profile: {},
  });
  assert.strictEqual(steps.find((s) => s.stepId === 'profile_review').completed, true);
});

check('currentStep is ai_resume_parsing right after upload, before parsing confidence lands', () => {
  const { steps } = progression.buildSteps({
    completedSteps: ['consent_saved', 'cv_uploaded'],
    progress: { confidence: { overall: 0 } },
    profile: {},
  });
  assert.strictEqual(progression.computeCurrentStep(steps), 'ai_resume_parsing');
});

// ─────────────────────────────────────────────────────────────────────────
// 4. Entry Method 2 — Guided Profile Builder
// ─────────────────────────────────────────────────────────────────────────
console.log('\n4. Entry Method 2 — Guided Profile Builder track');

check('detectTrack recognizes any guided_*_saved marker as GUIDED_BUILDER', () => {
  const track = progression.detectTrack(['consent_saved', 'guided_personal_details_saved']);
  assert.strictEqual(track, definition.TRACKS.GUIDED_BUILDER);
});

check('no upload_resume/ai_resume_parsing/profile_review appear for the Guided track', () => {
  const { steps } = progression.buildSteps({
    completedSteps: ['consent_saved', 'guided_personal_details_saved', 'guided_education_saved'],
    progress: {},
    profile: {},
  });
  const ids = steps.map((s) => s.stepId);
  assert.ok(!ids.includes('upload_resume'));
  assert.ok(!ids.includes('ai_resume_parsing'));
  assert.ok(!ids.includes('profile_review'));
  assert.deepStrictEqual(ids, [
    'consent', 'guided_personal_details', 'guided_education', 'guided_experience',
    'guided_skills', 'guided_career_goals', 'career_report', 'cv_generation',
  ]);
});

check('guided steps complete independently as their guided_*_saved markers appear', () => {
  const { steps } = progression.buildSteps({
    completedSteps: [
      'consent_saved',
      'guided_personal_details_saved',
      'guided_education_saved',
      'guided_experience_saved',
    ],
    progress: {},
    profile: {},
  });
  assert.strictEqual(steps.find((s) => s.stepId === 'guided_personal_details').completed, true);
  assert.strictEqual(steps.find((s) => s.stepId === 'guided_experience').completed, true);
  assert.strictEqual(steps.find((s) => s.stepId === 'guided_skills').completed, false);
});

// ─────────────────────────────────────────────────────────────────────────
// 5. Backward compatibility — pre-existing legacy manual endpoints
// ─────────────────────────────────────────────────────────────────────────
console.log('\n5. Legacy manual track (Task 5 — backward compatibility)');

check('a user with only education_experience_saved gets a populated legacy steps[]', () => {
  const { steps, track } = progression.buildSteps({
    completedSteps: ['consent_saved', 'education_experience_saved'],
    progress: { education: [{ school: 'MIT' }], career_report: null },
    profile: {},
  });
  assert.strictEqual(track, definition.TRACKS.LEGACY_MANUAL);
  assert.deepStrictEqual(steps.map((s) => s.stepId), [
    'consent', 'education_experience', 'career_intent', 'career_report', 'cv_generation',
  ]);
});

// ─────────────────────────────────────────────────────────────────────────
// 6. Completion convergence — both entry methods can reach isComplete
// ─────────────────────────────────────────────────────────────────────────
console.log('\n6. Completion — both tracks converge on the same isComplete signal');

check('Resume Upload track reaches isComplete via evaluateCompletion.trackAUpload', () => {
  const { isComplete } = progression.buildSteps({
    completedSteps: ['consent_saved', 'cv_uploaded'],
    progress: {
      cv_resume_id:     'resume-abc',
      personal_details: { full_name: 'Ada Lovelace' },
      confidence:       { overall: 80 },
    },
    profile: {},
  });
  assert.strictEqual(isComplete, true);
});

check('Guided Builder track reaches isComplete via evaluateCompletion.trackA (education/experience + career_report)', () => {
  const { isComplete } = progression.buildSteps({
    completedSteps: [
      'consent_saved', 'guided_personal_details_saved', 'guided_education_saved',
      'guided_experience_saved', 'guided_skills_saved', 'guided_career_goals_saved',
    ],
    progress: {
      education:     [{ school: 'MIT' }],
      career_report: { overallAssessment: 'Strong candidate' },
    },
    profile: {},
  });
  assert.strictEqual(isComplete, true);
});

// ─────────────────────────────────────────────────────────────────────────
// 7. computeStepStates — the fuller internal model (Task 3)
// ─────────────────────────────────────────────────────────────────────────
console.log('\n7. computeStepStates — current/completed/available/optional (Task 3)');

check('exactly one step is CURRENT and it is the first incomplete required step', () => {
  const { states } = progression.computeStepStates({
    completedSteps: ['consent_saved', 'cv_uploaded'],
    progress: { confidence: { overall: 0 } },
    profile: {},
  });
  const currentOnes = states.filter((s) => s.state === progression.STEP_STATES.CURRENT);
  assert.strictEqual(currentOnes.length, 1);
  assert.strictEqual(currentOnes[0].stepId, 'ai_resume_parsing');
});

check('optional shared downstream steps are marked OPTIONAL once a required CURRENT step exists earlier', () => {
  const { states } = progression.computeStepStates({
    completedSteps: ['consent_saved', 'cv_uploaded'],
    progress: { confidence: { overall: 0 } },
    profile: {},
  });
  const cvGen = states.find((s) => s.stepId === 'cv_generation');
  assert.strictEqual(cvGen.state, progression.STEP_STATES.OPTIONAL);
});

// ─────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
