'use strict';

/**
 * @file adminCmsComp03DeleteContractFix.test.js
 * @description WP-ADMIN-COMP-03 — regression coverage for the Career Domains
 * DELETE response-contract fix: the handler previously omitted `data` from
 * its success response, which the frontend API client's R1 check treats as
 * a hard parse failure. Fixed by adding `data: null`.
 */

const request = require('supertest');
const express = require('express');

function mockSupabaseModule() {
  const builder = {
    update: jest.fn(() => builder),
    eq: jest.fn(() => Promise.resolve({ error: null })),
  };
  const from = jest.fn(() => builder);
  return { supabase: { from } };
}

describe('Career Domains DELETE — data:null contract fix', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('response includes a `data` key (previously missing) alongside the existing message', async () => {
    jest.doMock('../../../../../config/supabase', () => mockSupabaseModule());

    const careerDomainsModule = require('../adminCmsCareerDomains.module');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.admin = { id: 'admin-1' }; next(); });
    app.use('/', careerDomainsModule.router);

    const res = await request(app).delete('/cd-1');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body).toHaveProperty('data', null);
    expect(res.body.message).toBe('Career domain deleted successfully');
  });
});
