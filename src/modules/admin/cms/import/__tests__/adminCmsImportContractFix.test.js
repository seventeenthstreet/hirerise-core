'use strict';

/**
 * @file adminCmsImportContractFix.test.js
 * @description WP-ADMIN-COMP-03 — regression coverage for the CMS Import
 * response-contract fix: `success:false` responses previously had no
 * `error` object, so none of the frontend's known error-wire-shapes matched
 * it — `duplicates`/`errors` were silently discarded and replaced with a
 * generic fallback message. Fixed by adding a conformant `error.details`
 * block using real BackendErrorCode values (CONFLICT / VALIDATION_ERROR),
 * and by mirroring `duplicates`/`errors` inside `data` so they also survive
 * the 207 partial-success path (apiRequest's success parser only returns
 * `raw.data`).
 */

const request = require('supertest');
const express = require('express');

function buildApp() {
  const importRoutes = require('../adminCmsImport.routes');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.admin = { id: 'admin-1' }; next(); });
  app.use('/', importRoutes);
  return app;
}

describe('CMS Import — error.details contract fix', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('an all-duplicate import (409) returns a V2-shaped error with BackendErrorCode "CONFLICT"', async () => {
    jest.doMock('../adminCmsImport.service', () => ({
      processImport: jest.fn(() =>
        Promise.resolve({
          total: 1, inserted: 0, skipped: 1, insertedIds: [],
          duplicates: [{ name: 'Python' }], errors: [],
        }),
      ),
    }));

    const res = await request(buildApp())
      .post('/')
      .send({ datasetType: 'skills', rows: [{ name: 'Python' }] });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(res.body.error.details.duplicates).toEqual([{ name: 'Python' }]);
    expect(res.body.duplicates).toEqual([{ name: 'Python' }]); // backward-compatible top-level key kept
    expect(res.body.data.duplicates).toEqual([{ name: 'Python' }]);
  });

  test('a validation/processing failure (422, no inserts, no duplicates) returns BackendErrorCode "VALIDATION_ERROR"', async () => {
    jest.doMock('../adminCmsImport.service', () => ({
      processImport: jest.fn(() =>
        Promise.resolve({
          total: 1, inserted: 0, skipped: 1, insertedIds: [],
          duplicates: [], errors: [{ index: 0, name: 'Python', message: 'RPC failed' }],
        }),
      ),
    }));

    const res = await request(buildApp())
      .post('/')
      .send({ datasetType: 'skills', rows: [{ name: 'Python' }] });

    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.errors).toEqual([{ index: 0, name: 'Python', message: 'RPC failed' }]);
  });

  test('a fully successful import (201) carries duplicates/errors inside `data` even though `success` is true', async () => {
    jest.doMock('../adminCmsImport.service', () => ({
      processImport: jest.fn(() =>
        Promise.resolve({
          total: 2, inserted: 2, skipped: 0, insertedIds: ['id-1', 'id-2'],
          duplicates: [], errors: [],
        }),
      ),
    }));

    const res = await request(buildApp())
      .post('/')
      .send({ datasetType: 'skills', rows: [{ name: 'Python' }, { name: 'Go' }] });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body).not.toHaveProperty('error');
    expect(res.body.data.inserted).toBe(2);
    expect(res.body.data.duplicates).toEqual([]);
  });

  test('a partial success (207: some inserted, some duplicates) still carries duplicates inside `data`', async () => {
    jest.doMock('../adminCmsImport.service', () => ({
      processImport: jest.fn(() =>
        Promise.resolve({
          total: 2, inserted: 1, skipped: 1, insertedIds: ['id-1'],
          duplicates: [{ name: 'Python' }], errors: [],
        }),
      ),
    }));

    const res = await request(buildApp())
      .post('/')
      .send({ datasetType: 'skills', rows: [{ name: 'Python' }, { name: 'Go' }] });

    expect(res.status).toBe(207);
    expect(res.body.success).toBe(true); // inserted > 0
    expect(res.body).not.toHaveProperty('error');
    // Without the fix, apiRequest's success parser (which only returns
    // `raw.data`) would have silently dropped these on the frontend.
    expect(res.body.data.duplicates).toEqual([{ name: 'Python' }]);
  });
});
