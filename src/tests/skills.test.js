'use strict';

/**
 * @file src/tests/skills.api.test.js
 * @description
 * Skills API validation boundary tests.
 */

const request = require('supertest');
const app = require('../app');

describe('Skills API', () => {
  test('rejects more than 200 user skills', async () => {
    const userSkills = Array.from(
      { length: 201 },
      (_, i) => ({
        name: `skill_${i}`,
        level: 3,
      })
    );

    const res = await request(app)
      .post('/api/v1/skills/gap-analysis')
      .send({
        targetRoleId: 'software-engineer',
        userSkills,
      });

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
  });
});