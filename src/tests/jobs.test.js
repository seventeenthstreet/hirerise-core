'use strict';

/**
 * @file src/tests/jobs.test.js
 * @description
 * Minimal health endpoint smoke test for Supabase-era boot safety.
 */

const request = require('supertest');
const app = require('../app');

describe('Jobs API', () => {
  test('GET /api/v1/health returns 200 and success=true', async () => {
    const res = await request(app).get('/api/v1/health');

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('success', true);
  });
});