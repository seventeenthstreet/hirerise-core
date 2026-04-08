'use strict';

/**
 * @file test/career.api.integration.test.js
 * @description
 * Minimal Supabase-era smoke tests for Career API validation contracts.
 */

const request = require('supertest');
const app = require('../app');

describe('Career API', () => {
  test('POST /career/path-with-gap returns 400 for invalid payload', async () => {
    const res = await request(app)
      .post('/api/v1/career/path-with-gap')
      .send({});

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
  });
});