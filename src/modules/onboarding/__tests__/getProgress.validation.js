'use strict';

/**
 * @file src/modules/onboarding/__tests__/getProgress.validation.js
 *
 * WP-PRO-08 — Validation script for the actual Progress API entry point,
 * onboarding.analytics.service.js#getProgress(), with a stub Supabase
 * client so the real `@supabase/supabase-js` package (not installed in
 * this environment) is never touched. Same methodology as
 * professionalOnboardingDefinition.validation.js.
 *
 * Run with:
 *   node src/modules/onboarding/__tests__/getProgress.validation.js
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
    console.error(`         ${err.stack || err.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL - ${name}`);
    console.error(`         ${err.stack || err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Mock config/supabase and utils/logger before onboarding.analytics.service
// (and its dependency chain, including onboarding.helpers.js) is required.
// ─────────────────────────────────────────────────────────────────────────

// Rows keyed by "table:userId" so different fixtures can be swapped in per
// check without re-requiring the module.
let fixtures = {};

function setFixtures(next) {
  fixtures = next;
}

function makeSupabaseStub() {
  return {
    from(table) {
      return {
        select() {
          return {
            eq(_col, userId) {
              return {
                async maybeSingle() {
                  return { data: fixtures[`${table}:${userId}`] ?? null, error: null };
                },
              };
            },
          };
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
const supabaseStub = makeSupabaseStub();
injectMockModule(path.resolve(testDir, '../../../config/supabase.js'), { supabase: supabaseStub });
injectMockModule(path.resolve(testDir, '../../../utils/logger.js'), loggerStub);

// ─────────────────────────────────────────────────────────────────────────
// Now safe to require the module under test.
// ─────────────────────────────────────────────────────────────────────────

const analytics = require('../onboarding.analytics.service');

async function main() {
  console.log('WP-PRO-08 getProgress() Progress API integration — Validation\n');

  console.log('1. Brand-new user (no onboarding_progress row)');
  await checkAsync('returns populated steps[] instead of [] ("0 of 0 steps" fix)', async () => {
    setFixtures({}); // nothing exists for this user in any table
    const result = await analytics.getProgress('user-new');
    assert.deepStrictEqual(result.steps, [{ stepId: 'consent', completed: false }]);
    assert.strictEqual(result.currentStep, 'consent');
    assert.strictEqual(result.onboardingCompleted, false);
    assert.deepStrictEqual(result.completedSteps, []);
  });

  console.log('\n2. Returning Resume Upload user, mid-flow');
  await checkAsync('steps[] reflects the Resume Upload track; currentStep is correct', async () => {
    setFixtures({
      'onboarding_progress:user-upload': {
        step: 'cv_uploaded',
        step_history: [
          { step: 'consent_saved', at: '2026-07-01T00:00:00Z' },
          { step: 'cv_uploaded', at: '2026-07-01T00:05:00Z' },
        ],
        onboarding_completed_at: null,
        updated_at: '2026-07-01T00:05:00Z',
        confidence: { overall: 0 },
        cv_resume_id: 'resume-1',
        personal_details: null,
        full_name: null,
        education: null,
        experience: null,
        career_report: null,
      },
      'users:user-upload': { onboarding_completed: false },
      'user_profiles:user-upload': { career_history: [], expected_role_ids: [] },
    });

    const result = await analytics.getProgress('user-upload');

    assert.strictEqual(result.step, 'cv_uploaded'); // backward-compat field retained
    assert.strictEqual(result.currentStep, 'ai_resume_parsing'); // new field, correct value
    assert.deepStrictEqual(result.completedSteps, ['consent_saved', 'cv_uploaded']);
    assert.deepStrictEqual(
      result.steps.map((s) => s.stepId),
      ['consent', 'upload_resume', 'ai_resume_parsing', 'profile_review', 'career_report', 'cv_generation'],
    );
    assert.strictEqual(result.steps.find((s) => s.stepId === 'upload_resume').completed, true);
    assert.strictEqual(result.onboardingCompleted, false);
  });

  console.log('\n3. Returning Guided Builder user, mid-flow');
  await checkAsync('steps[] reflects the Guided Builder track exclusively', async () => {
    setFixtures({
      'onboarding_progress:user-guided': {
        step: null,
        step_history: [
          { step: 'consent_saved', at: '2026-07-01T00:00:00Z' },
          { step: 'guided_personal_details_saved', at: '2026-07-01T00:01:00Z' },
        ],
        onboarding_completed_at: null,
        updated_at: '2026-07-01T00:01:00Z',
        confidence: null,
        cv_resume_id: null,
        personal_details: null,
        full_name: null,
        education: null,
        experience: null,
        career_report: null,
      },
      'users:user-guided': { onboarding_completed: false },
      'user_profiles:user-guided': { career_history: [], expected_role_ids: [] },
    });

    const result = await analytics.getProgress('user-guided');

    assert.deepStrictEqual(
      result.steps.map((s) => s.stepId),
      ['consent', 'guided_personal_details', 'guided_education', 'guided_experience',
        'guided_skills', 'guided_career_goals', 'career_report', 'cv_generation'],
    );
    assert.strictEqual(result.currentStep, 'guided_education');
  });

  console.log('\n4. Already-complete user — users.onboarding_completed still authoritative');
  await checkAsync('onboardingCompleted true short-circuits from users table as before', async () => {
    setFixtures({
      'onboarding_progress:user-done': {
        step: 'completed',
        step_history: [{ step: 'consent_saved', at: '2026-07-01T00:00:00Z' }, { step: 'cv_uploaded', at: '2026-07-01T00:05:00Z' }],
        onboarding_completed_at: '2026-07-01T00:10:00Z',
        updated_at: '2026-07-01T00:10:00Z',
        confidence: { overall: 90 },
        cv_resume_id: 'resume-2',
        personal_details: { full_name: 'Ada Lovelace' },
        full_name: null,
        education: null,
        experience: null,
        career_report: null,
      },
      'users:user-done': { onboarding_completed: true },
      'user_profiles:user-done': { career_history: [], expected_role_ids: [] },
    });

    const result = await analytics.getProgress('user-done');
    assert.strictEqual(result.onboardingCompleted, true);
    assert.strictEqual(result.completedAt, '2026-07-01T00:10:00Z');
  });

  console.log(`\n${passed} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main();
