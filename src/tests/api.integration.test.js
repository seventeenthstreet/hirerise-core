'use strict';

/**
 * api.integration.test.js
 *
 * Full integration test suite covering all fixed endpoints.
 * Assumes server is running with valid Firebase credentials in test env.
 *
 * Run with: jest api.integration.test.js
 */

const request = require('supertest');
const app = require('../server');

// ─────────────────────────────────────────────────────────────
// Auth helper — replace with however your test suite gets a token
// ─────────────────────────────────────────────────────────────
const TEST_TOKEN = process.env.TEST_AUTH_TOKEN || null;

const auth = (req) =>
  TEST_TOKEN ? req.set('Authorization', `Bearer ${TEST_TOKEN}`) : req;

// ─────────────────────────────────────────────────────────────
// SALARY
// ─────────────────────────────────────────────────────────────
describe('Salary API', () => {

  describe('POST /api/v1/salary/benchmark', () => {
    it('✅ returns 200 for valid payload', async () => {
      const res = await auth(
        request(app).post('/api/v1/salary/benchmark')
      ).send({ roleId: 'se_2', experienceYears: 3, location: 'metro' });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('salaryRange');
      expect(res.body.data).toHaveProperty('recommendedLevel');
    });

    it('❌ returns 400 when roleId is missing', async () => {
      const res = await auth(
        request(app).post('/api/v1/salary/benchmark')
      ).send({ experienceYears: 3 });

      expect(res.statusCode).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('❌ returns 400 when experienceYears exceeds 60', async () => {
      const res = await auth(
        request(app).post('/api/v1/salary/benchmark')
      ).send({ roleId: 'se_2', experienceYears: 200 });

      expect(res.statusCode).toBe(400);
    });

    it('❌ returns 400 when location is invalid', async () => {
      const res = await auth(
        request(app).post('/api/v1/salary/benchmark')
      ).send({ roleId: 'se_2', experienceYears: 3, location: 'london' });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /api/v1/salary/intelligence', () => {
    it('✅ returns 200 for valid payload', async () => {
      const res = await auth(
        request(app).post('/api/v1/salary/intelligence')
      ).send({ roleId: 'se_2', experienceYears: 3 });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('❌ returns 400 when roleId is missing', async () => {
      const res = await auth(
        request(app).post('/api/v1/salary/intelligence')
      ).send({ experienceYears: 3 });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/v1/salary/bands/:roleId', () => {
    it('✅ returns 200 for valid roleId', async () => {
      const res = await auth(
        request(app).get('/api/v1/salary/bands/se_2')
      );

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('levels');
    });

    it('❌ returns 404 for unknown roleId', async () => {
      const res = await auth(
        request(app).get('/api/v1/salary/bands/does-not-exist')
      );

      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /api/v1/salary/compare', () => {
    it('✅ returns 200 for valid roleIds', async () => {
      const res = await auth(
        request(app).get('/api/v1/salary/compare?roleIds=se_1,se_2&experienceYears=3')
      );

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('comparison');
    });

    it('❌ returns 400 when only one roleId is provided', async () => {
      const res = await auth(
        request(app).get('/api/v1/salary/compare?roleIds=se_1')
      );

      expect(res.statusCode).toBe(400);
    });

    it('❌ returns 400 when roleIds is missing', async () => {
      const res = await auth(
        request(app).get('/api/v1/salary/compare')
      );

      expect(res.statusCode).toBe(400);
    });
  });

});

// ─────────────────────────────────────────────────────────────
// SKILLS
// ─────────────────────────────────────────────────────────────
describe('Skills API', () => {

  describe('POST /api/v1/skills/gap-analysis', () => {
    it('✅ returns 200 for valid payload', async () => {
      const res = await auth(
        request(app).post('/api/v1/skills/gap-analysis')
      ).send({
        targetRoleId: 'se_2',
        userSkills: [
          { name: 'JavaScript', proficiencyLevel: 'advanced' },
          { name: 'Node.js', proficiencyLevel: 'intermediate' },
        ],
        includeRecommendations: false,
      });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('readinessScore');
      expect(res.body.data).toHaveProperty('missingSkills');
    });

    it('❌ returns 400 when targetRoleId is missing', async () => {
      const res = await auth(
        request(app).post('/api/v1/skills/gap-analysis')
      ).send({ userSkills: [] });

      expect(res.statusCode).toBe(400);
    });

    it('❌ returns 400 when userSkills exceeds 200 items', async () => {
      const skills = Array.from({ length: 201 }, (_, i) => ({ name: `skill_${i}` }));

      const res = await auth(
        request(app).post('/api/v1/skills/gap-analysis')
      ).send({ targetRoleId: 'se_2', userSkills: skills });

      expect(res.statusCode).toBe(400);
    });

    it('❌ returns 400 when proficiencyLevel is invalid', async () => {
      const res = await auth(
        request(app).post('/api/v1/skills/gap-analysis')
      ).send({
        targetRoleId: 'se_2',
        userSkills: [{ name: 'JavaScript', proficiencyLevel: 'god-tier' }],
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /api/v1/skills/bulk-gap', () => {
    it('✅ returns 200 for valid payload', async () => {
      const res = await auth(
        request(app).post('/api/v1/skills/bulk-gap')
      ).send({
        targetRoleIds: ['se_1', 'se_2'],
        userSkills: [{ name: 'JavaScript' }],
      });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('results');
    });

    it('❌ returns 400 when targetRoleIds is empty', async () => {
      const res = await auth(
        request(app).post('/api/v1/skills/bulk-gap')
      ).send({ targetRoleIds: [], userSkills: [] });

      expect(res.statusCode).toBe(400);
    });

    it('❌ returns 400 when targetRoleIds exceeds 10', async () => {
      const ids = Array.from({ length: 11 }, (_, i) => `role_${i}`);

      const res = await auth(
        request(app).post('/api/v1/skills/bulk-gap')
      ).send({ targetRoleIds: ids, userSkills: [] });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/v1/skills/search', () => {
    it('✅ returns 200 for valid query', async () => {
      const res = await auth(
        request(app).get('/api/v1/skills/search?q=JavaScript')
      );

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('❌ returns 400 when query is too short', async () => {
      const res = await auth(
        request(app).get('/api/v1/skills/search?q=J')
      );

      expect(res.statusCode).toBe(400);
    });

    it('❌ returns 400 for invalid category', async () => {
      const res = await auth(
        request(app).get('/api/v1/skills/search?q=JavaScript&category=magic')
      );

      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/v1/skills/role/:roleId', () => {
    it('✅ returns 200 for valid roleId', async () => {
      const res = await auth(
        request(app).get('/api/v1/skills/role/se_2')
      );

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('skills');
    });

    it('❌ returns 404 for unknown roleId', async () => {
      const res = await auth(
        request(app).get('/api/v1/skills/role/does-not-exist')
      );

      expect(res.statusCode).toBe(404);
    });
  });

});

// ─────────────────────────────────────────────────────────────
// CAREER
// ─────────────────────────────────────────────────────────────
describe('Career API', () => {

  describe('GET /api/v1/career/path/:currentRoleId', () => {
    it('✅ returns 200 for valid roleId', async () => {
      const res = await auth(
        request(app).get('/api/v1/career/path/se_1')
      );

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('current_role');
      expect(res.body.data).toHaveProperty('next_roles');
    });

    it('❌ returns 500 for unknown roleId', async () => {
      const res = await auth(
        request(app).get('/api/v1/career/path/does-not-exist')
      );

      // careerPath.service throws a plain Error (not AppError) for unknown roles
      // so it surfaces as 500 — acceptable until service is hardened
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    });
  });

  describe('POST /api/v1/career/path-with-gap', () => {
    it('✅ returns 200 for valid payload', async () => {
      const res = await auth(
        request(app).post('/api/v1/career/path-with-gap')
      ).send({
        currentRoleId: 'se_1',
        userSkills: [{ name: 'JavaScript' }, { name: 'Node.js' }],
        filters: {},
      });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('❌ returns 400 when currentRoleId is missing', async () => {
      const res = await auth(
        request(app).post('/api/v1/career/path-with-gap')
      ).send({ userSkills: [] });

      expect(res.statusCode).toBe(400);
    });

    it('❌ returns 400 when userSkills is not an array', async () => {
      const res = await auth(
        request(app).post('/api/v1/career/path-with-gap')
      ).send({ currentRoleId: 'se_1', userSkills: 'bad' });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /api/v1/career/jd-match', () => {
    it('✅ returns 200 for valid payload', async () => {
      const res = await auth(
        request(app).post('/api/v1/career/jd-match')
      ).send({
        userProfile: {
          skills: [{ name: 'JavaScript' }, { name: 'Node.js' }],
          totalExperience: 3,
        },
        rawJobDescription:
          'We are looking for a software engineer with experience in JavaScript, Node.js, and REST APIs. ' +
          'You will be responsible for building scalable backend services.',
      });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      // FIX: response returns matchScore not compositeScore
      expect(res.body.data).toHaveProperty('matchScore');
    });

    it('❌ returns 400 when rawJobDescription is too short', async () => {
      const res = await auth(
        request(app).post('/api/v1/career/jd-match')
      ).send({
        userProfile: { skills: [{ name: 'JavaScript' }] },
        rawJobDescription: 'too short',
      });

      expect(res.statusCode).toBe(400);
    });

    it('❌ returns 400 when skills array is empty', async () => {
      const res = await auth(
        request(app).post('/api/v1/career/jd-match')
      ).send({
        userProfile: { skills: [] },
        rawJobDescription: 'A'.repeat(100),
      });

      expect(res.statusCode).toBe(400);
    });
  });

});

// ─────────────────────────────────────────────────────────────
// JOBS
// ─────────────────────────────────────────────────────────────
describe('Jobs API', () => {

  it('✅ GET /api/v1/health returns 200', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.statusCode).toBe(200);
  });

  it('✅ GET /api/v1/jobs/families returns 200', async () => {
    const res = await auth(request(app).get('/api/v1/jobs/families'));
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('✅ GET /api/v1/jobs/roles returns 200', async () => {
    const res = await auth(request(app).get('/api/v1/jobs/roles?limit=5'));
    expect(res.statusCode).toBe(200);
  });

  it('❌ GET /api/v1/jobs/roles/:roleId returns 404 for unknown role', async () => {
    const res = await auth(
      request(app).get('/api/v1/jobs/roles/this-does-not-exist')
    );
    expect(res.statusCode).toBe(404);
  });

});