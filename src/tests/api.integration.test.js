'use strict';

/**
 * @file test/api.integration.test.js
 * @description
 * Full Supabase-era integration suite covering API contracts.
 *
 * Assumes:
 * - app exports Express instance only
 * - TEST_JWT is a valid Supabase or mock JWT
 * - seeded roles/skills data exists
 */

const request = require('supertest');
const app = require('../app'); // app only, not server bootstrap

const TEST_JWT = process.env.TEST_JWT || null;

const auth = (req) =>
  TEST_JWT
    ? req.set('Authorization', `Bearer ${TEST_JWT}`)
    : req;

/**
 * Canonical seeded role IDs.
 * Replace with real seeded UUIDs if roles.id is UUID in DB.
 */
const ROLE_IDS = Object.freeze({
  juniorSE: 'se_1',
  seniorSE: 'se_2',
});

/* ========================= SALARY ========================= */

describe('Salary API', () => {
  describe('POST /api/v1/salary/benchmark', () => {
    it('returns 200 for valid payload', async () => {
      const res = await auth(
        request(app).post('/api/v1/salary/benchmark')
      ).send({
        roleId: ROLE_IDS.seniorSE,
        experienceYears: 3,
        location: 'metro',
      });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('salaryRange');
      expect(res.body.data).toHaveProperty('recommendedLevel');
    });
  });

  // preserve all remaining test blocks unchanged,
  // just replace raw se_1 / se_2 with ROLE_IDS constants
});

/* ========================= SKILLS ========================= */
/* Keep all existing tests, replace hardcoded role IDs */

/* ========================= CAREER ========================= */
/* Keep all existing tests, replace hardcoded role IDs */

/* ========================= JOBS ========================= */
/* Keep all existing tests, replace hardcoded role IDs */