'use strict';

const request = require('supertest');
const app = require('../server');

describe('Salary API', () => {

  describe('POST /api/v1/salary/benchmark', () => {

    it('should return 400 for missing roleId', async () => {
      const res = await request(app)
        .post('/api/v1/salary/benchmark')
        .send({ experienceYears: 5 });

      expect(res.statusCode).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('should validate experienceYears bounds', async () => {
      const res = await request(app)
        .post('/api/v1/salary/benchmark')
        .send({
          roleId: 'software-engineer',
          experienceYears: 200
        });

      expect(res.statusCode).toBe(400);
    });

  });

});









