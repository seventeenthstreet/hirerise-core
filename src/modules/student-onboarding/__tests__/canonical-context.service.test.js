'use strict';

/**
 * modules/student-onboarding/__tests__/canonical-context.service.test.js
 *
 * Covers Phase 0 brief §23 acceptance criteria for the canonical context
 * foundation:
 *   1. Student with complete canonical data.
 *   2. Student with partial optional cognitive data.
 *   3. Student with no activities.
 *   4. Student with no achievements.
 *   5. Student with aspiration data.
 *   6. No legacy Recommendation tables are queried by the new context
 *      foundation (asserted by only mocking the canonical repositories and
 *      the education table read; no other module is required).
 *   7. Context version exists.
 *   8. Student ID is correctly scoped (passed through unchanged to every
 *      canonical read).
 *
 * Education has no dedicated repository module (unlike academics/
 * activities/cognitive/aspiration), so canonical-context.service.js reads
 * student_education_profiles directly via the injected Supabase client
 * (see that file's header comment for why education.service.js itself is
 * not imported — Doc 08 dependency rules forbid service-to-service
 * imports). The fake client below stubs exactly that query chain.
 *
 * PHASE 1 ADDITIONS covered here:
 *   9.  Intelligence available (getStudentVector/getStudentConfidence).
 *   10. Intelligence unavailable/partial (read throws) does not fail
 *       context assembly and does not fabricate a value.
 *   11. Readiness/completion summary shape.
 *   12. Forbidden legacy tables are not queried — asserted structurally:
 *       only the canonical repositories + education table + intelligence
 *       service are mocked; nothing else is required by this module, so
 *       no other table/module can be reached.
 *   13. Financial fields are absent — the assembled context has no
 *       financial key anywhere; nothing here reads or exposes one.
 *   14. Favourite/challenging subjects are absent — same reasoning.
 */

const {
  getContextVersion,
  assembleCanonicalStudentContext,
} = require('../services/canonical-context.service');

jest.mock('../repositories/academic.repository', () => ({
  fetchAcademicData: jest.fn(),
}));
jest.mock('../repositories/activity.repository', () => ({
  fetchStudentActivityData: jest.fn(),
}));
jest.mock('../repositories/cognitive.repository', () => ({
  fetchStudentCognitiveData: jest.fn(),
}));
jest.mock('../repositories/aspiration.repository', () => ({
  fetchAspiration: jest.fn(),
}));
jest.mock('../services/intelligence.service', () => ({
  getStudentVector: jest.fn(),
  getStudentConfidence: jest.fn(),
}));

const { fetchAcademicData } = require('../repositories/academic.repository');
const { fetchStudentActivityData } = require('../repositories/activity.repository');
const { fetchStudentCognitiveData } = require('../repositories/cognitive.repository');
const { fetchAspiration } = require('../repositories/aspiration.repository');
const intelligenceService = require('../services/intelligence.service');

const USER_ID = 'user-123';

/**
 * Builds a fake Supabase client whose only exercised chain is
 * .from('student_education_profiles').select().eq().maybeSingle(),
 * matching exactly what canonical-context.service.js's inline
 * fetchEducationProfile() calls.
 */
function buildFakeSupabase(educationResult) {
  const maybeSingle = jest.fn().mockResolvedValue({ data: educationResult ?? null, error: null });
  const eq = jest.fn().mockReturnValue({ maybeSingle });
  const select = jest.fn().mockReturnValue({ eq });
  const from = jest.fn().mockReturnValue({ select });
  return { from };
}

/**
 * Wires up all canonical-source mocks for one test and returns the fake
 * Supabase client to inject into assembleCanonicalStudentContext.
 */
function setup({
  education = { education_level: 'class_12' },
  academics = { records: [], subjects: [] },
  activityData = { activities: [], achievements: [], reflection: null },
  aspiration = null,
  cognitive = { responses: [], signals: null },
  cognitiveThrows = false,
  intelligenceVector = null,
  intelligenceConfidence = [],
  intelligenceThrows = false,
} = {}) {
  fetchAcademicData.mockResolvedValue(academics);
  fetchStudentActivityData.mockResolvedValue(activityData);
  fetchAspiration.mockResolvedValue(aspiration);

  if (cognitiveThrows) {
    fetchStudentCognitiveData.mockRejectedValue(new Error('cognitive read failed'));
  } else {
    fetchStudentCognitiveData.mockResolvedValue(cognitive);
  }

  if (intelligenceThrows) {
    intelligenceService.getStudentVector.mockRejectedValue(new Error('vector read failed'));
    intelligenceService.getStudentConfidence.mockRejectedValue(new Error('confidence read failed'));
  } else {
    intelligenceService.getStudentVector.mockResolvedValue(intelligenceVector);
    intelligenceService.getStudentConfidence.mockResolvedValue(intelligenceConfidence);
  }

  return { fakeSupabase: buildFakeSupabase(education), activityData, aspiration };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('canonical-context.service', () => {
  describe('getContextVersion', () => {
    it('returns a deterministic, non-empty version string', () => {
      // 7. Context version exists.
      expect(getContextVersion()).toBe('student-recommendation-context-v2');
      expect(getContextVersion()).toBe(getContextVersion());
    });
  });

  describe('assembleCanonicalStudentContext', () => {
    it('1. assembles a complete context when all canonical sources have data', async () => {
      const { fakeSupabase, activityData, aspiration } = setup({
        academics: { records: [{ academic_year: '2024' }], subjects: [{ subject: 'Math' }] },
        activityData: {
          activities: [{ activity_key: 'coding' }],
          achievements: [{ id: 'ach-1' }],
          reflection: { reflection_text: 'grew a lot' },
        },
        aspiration: { career_interests: ['engineer'] },
        cognitive: { responses: [{ id: 'r1' }], signals: { analytical_score: 80 } },
      });

      const context = await assembleCanonicalStudentContext(USER_ID, fakeSupabase);

      expect(context.education).toEqual({ education_level: 'class_12' });
      expect(context.academics.records).toHaveLength(1);
      expect(context.activities.activities).toHaveLength(1);
      expect(context.achievements).toEqual(activityData.achievements);
      expect(context.aspiration).toEqual(aspiration);
      expect(context.cognitive.signals.analytical_score).toBe(80);
      expect(context.contextVersion).toBe(getContextVersion());
    });

    it('2. tolerates missing/partial optional cognitive data without failing', async () => {
      const { fakeSupabase } = setup({ cognitiveThrows: true });

      const context = await assembleCanonicalStudentContext(USER_ID, fakeSupabase);

      expect(context.cognitive).toBeNull();
      expect(context.contextVersion).toBe(getContextVersion());
    });

    it('3. handles a student with no activities', async () => {
      const { fakeSupabase } = setup({
        activityData: { activities: [], achievements: [], reflection: null },
      });

      const context = await assembleCanonicalStudentContext(USER_ID, fakeSupabase);

      expect(context.activities.activities).toEqual([]);
    });

    it('4. handles a student with no achievements', async () => {
      const { fakeSupabase } = setup({
        activityData: { activities: [{ activity_key: 'chess' }], achievements: [], reflection: null },
      });

      const context = await assembleCanonicalStudentContext(USER_ID, fakeSupabase);

      expect(context.achievements).toEqual([]);
    });

    it('5. surfaces aspiration data unmodified when present', async () => {
      const aspirationData = { career_interests: ['doctor'], motivation_driver: 'impact' };
      const { fakeSupabase } = setup({ aspiration: aspirationData });

      const context = await assembleCanonicalStudentContext(USER_ID, fakeSupabase);

      expect(context.aspiration).toEqual(aspirationData);
    });

    it('8. scopes every canonical read to the given userId', async () => {
      const { fakeSupabase } = setup();

      await assembleCanonicalStudentContext(USER_ID, fakeSupabase);

      expect(fakeSupabase.from).toHaveBeenCalledWith('student_education_profiles');
      expect(fetchAcademicData).toHaveBeenCalledWith(fakeSupabase, USER_ID);
      expect(fetchStudentActivityData).toHaveBeenCalledWith(fakeSupabase, USER_ID);
      expect(fetchStudentCognitiveData).toHaveBeenCalledWith(fakeSupabase, USER_ID);
      expect(fetchAspiration).toHaveBeenCalledWith(fakeSupabase, USER_ID);
    });

    it('rejects a missing/invalid userId rather than silently scoping to nothing', async () => {
      const { fakeSupabase } = setup();
      await expect(assembleCanonicalStudentContext(undefined, fakeSupabase)).rejects.toThrow(TypeError);
    });

    it('9. includes Intelligence vector/confidence when available', async () => {
      const vector = { technical_aptitude: 0.8 };
      const confidence = [{ signal_key: 'technical_aptitude', confidence: 0.7 }];
      const { fakeSupabase } = setup({ intelligenceVector: vector, intelligenceConfidence: confidence });

      const context = await assembleCanonicalStudentContext(USER_ID, fakeSupabase);

      expect(context.intelligence.vector).toEqual(vector);
      expect(context.intelligence.confidence).toEqual(confidence);
      expect(context.readiness.intelligenceAvailable).toBe(true);
    });

    it('10. tolerates unavailable/partial Intelligence without failing or fabricating values', async () => {
      const { fakeSupabase } = setup({ intelligenceThrows: true });

      const context = await assembleCanonicalStudentContext(USER_ID, fakeSupabase);

      expect(context.intelligence.vector).toBeNull();
      expect(context.intelligence.confidence).toEqual([]);
      expect(context.readiness.intelligenceAvailable).toBe(false);
    });

    it('11. derives a readiness summary reflecting which domains have data', async () => {
      const { fakeSupabase } = setup({
        education: { education_level: 'class_12' },
        academics: { records: [{ academic_year: '2024' }], subjects: [] },
        activityData: { activities: [], achievements: [], reflection: null },
        aspiration: null,
        cognitive: { responses: [], signals: null },
      });

      const context = await assembleCanonicalStudentContext(USER_ID, fakeSupabase);

      expect(context.readiness).toEqual({
        education: true,
        academics: true,
        activities: false,
        cognitive: false,
        aspiration: false,
        intelligenceAvailable: false,
      });
    });

    it('12. never queries any legacy Recommendation table (only canonical repositories, education table, and Intelligence query methods are mocked)', async () => {
      const { fakeSupabase } = setup();

      await assembleCanonicalStudentContext(USER_ID, fakeSupabase);

      // The only table this module queries directly is student_education_profiles;
      // all other reads go through the mocked canonical repositories/service.
      expect(fakeSupabase.from).toHaveBeenCalledTimes(1);
      expect(fakeSupabase.from).toHaveBeenCalledWith('student_education_profiles');
    });

    it('13. never includes any financial field in the assembled context', async () => {
      const { fakeSupabase } = setup();
      const context = await assembleCanonicalStudentContext(USER_ID, fakeSupabase);

      expect(JSON.stringify(context)).not.toMatch(/financial|budget|loan_openness|relocation/i);
    });

    it('14. never includes favourite/challenging subjects in the assembled context', async () => {
      const { fakeSupabase } = setup();
      const context = await assembleCanonicalStudentContext(USER_ID, fakeSupabase);

      expect(JSON.stringify(context)).not.toMatch(/favourite_subjects|challenging_subjects/i);
    });
  });
});
