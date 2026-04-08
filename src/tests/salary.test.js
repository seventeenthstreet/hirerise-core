'use strict';

/**
 * @file src/tests/salary.api.test.js
 * @description
 * Salary API validation smoke tests.
 */

const request = require('supertest');
const app = require('../app');

describe('Salary API', () => {
  describe('POST /api/v1/salary/benchmark', () => {
    it('returns 400 for missing roleId', async () => {
      const res = await request(app)
        .post('/api/v1/salary/benchmark')
        .send({ experienceYears: 5 });

      expect(res.statusCode).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('validates experienceYears upper bound', async () => {
      const res = await request(app)
        .post('/api/v1/salary/benchmark')
        .send({
          roleId: 'software-engineer',
          experienceYears: 200,
        });

      expect(res.statusCode).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });
});