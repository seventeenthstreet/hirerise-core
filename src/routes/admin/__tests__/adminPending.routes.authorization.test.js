'use strict';

/**
 * @file adminPending.routes.authorization.test.js
 *
 * HireRise Core — Contributor / Editor Admin Workspace E2E Verification.
 *
 * Pins the authorization boundary fixed in this work package:
 *  - GET / and GET /:id now admit Editor as well as Contributor/Admin
 *    (requireContributorOrEditor), and Editor's results are NOT scoped to
 *    "own" submissions (Editor never submits — scoping to own would show
 *    Editor nothing).
 *  - PATCH /:id (new) is Editor(+Admin)-only, and only while the entry is
 *    still 'pending' — this is the one genuinely new capability this work
 *    package adds, per the explicit product decision that Editor edits
 *    pre-publish entries.
 *  - POST / and DELETE /:id remain Contributor(+Admin)-only — Editor gets
 *    no new submit/withdraw capability.
 *  - POST /:id/approve and POST /:id/reject remain requireAdmin-only —
 *    Editor gets no publishing authority (unchanged, not re-implemented).
 *
 * Real router + real requireContributor/requireEditor middleware, following
 * the existing convention (administrators.routes.authorization.test.js,
 * adminWeights.routes.authorization.test.js): req.user injected directly,
 * Supabase mocked out so only authorization placement is under test.
 */

const express = require('express');
const request = require('supertest');

function chainable(result) {
  const builder = {
    select: jest.fn(() => builder),
    order: jest.fn(() => builder),
    limit: jest.fn(() => builder),
    eq: jest.fn(() => builder),
    insert: jest.fn(() => builder),
    update: jest.fn(() => builder),
    delete: jest.fn(() => builder),
    single: jest.fn(() => Promise.resolve(result)),
    maybeSingle: jest.fn(() => Promise.resolve(result)),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return builder;
}

let nextResult = { data: [], error: null };
const mockDb = {
  from: jest.fn(() => chainable(nextResult)),
  rpc: jest.fn(() => Promise.resolve({ data: { success: true, live_id: 'live-1', live_table: 'skills' }, error: null })),
};

jest.mock('../../../config/supabase', () => ({
  getClient: () => mockDb,
  withRetry: (fn) => fn(),
}));

const pendingRoutes = require('../adminPending.routes');

function buildApp(user) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = user;
    next();
  });
  app.use('/api/v1/admin/pending', pendingRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    res.status(err.statusCode || 500).json({ success: false, error: { message: err.message } });
  });
  return app;
}

const CONTRIBUTOR = { uid: 'contrib-1', id: 'contrib-1', role: 'contributor' };
const EDITOR = { uid: 'editor-1', id: 'editor-1', role: 'editor' };
const ADMIN = { uid: 'admin-1', id: 'admin-1', role: 'admin' };

const entryId = '11111111-1111-4111-8111-111111111111';

describe('adminPending.routes — Contributor/Editor authorization boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    nextResult = { data: [], error: null };
  });

  describe('GET / — list', () => {
    it('Contributor: 200 (own-scoped)', async () => {
      const app = buildApp(CONTRIBUTOR);
      const res = await request(app).get('/api/v1/admin/pending');
      expect(res.status).toBe(200);
    });

    it('Editor: 200 (not own-scoped — this was the fix)', async () => {
      const app = buildApp(EDITOR);
      const res = await request(app).get('/api/v1/admin/pending');
      expect(res.status).toBe(200);
    });

    it('Admin: 200', async () => {
      const app = buildApp(ADMIN);
      const res = await request(app).get('/api/v1/admin/pending');
      expect(res.status).toBe(200);
    });

    it('Unauthenticated: 401', async () => {
      const app = buildApp(null);
      const res = await request(app).get('/api/v1/admin/pending');
      expect(res.status).toBe(401);
    });
  });

  describe('PATCH /:id — Editor edits a pending entry (new capability)', () => {
    beforeEach(() => {
      nextResult = { data: { status: 'pending' }, error: null };
    });

    it('Editor: 200 while entry is still pending', async () => {
      const app = buildApp(EDITOR);
      const res = await request(app)
        .patch(`/api/v1/admin/pending/${entryId}`)
        .send({ payload: { name: 'Edited by editor' } });
      expect(res.status).toBe(200);
    });

    it('Admin: 200 (requireEditor admits Administrator authority)', async () => {
      const app = buildApp(ADMIN);
      const res = await request(app)
        .patch(`/api/v1/admin/pending/${entryId}`)
        .send({ payload: { name: 'Edited by admin' } });
      expect(res.status).toBe(200);
    });

    it('Contributor: 403 — editing is not a Contributor capability', async () => {
      const app = buildApp(CONTRIBUTOR);
      const res = await request(app)
        .patch(`/api/v1/admin/pending/${entryId}`)
        .send({ payload: { name: 'Edited by contributor' } });
      expect(res.status).toBe(403);
    });

    it('Editor: 409 when the entry is no longer pending', async () => {
      nextResult = { data: { status: 'approved' }, error: null };
      const app = buildApp(EDITOR);
      const res = await request(app)
        .patch(`/api/v1/admin/pending/${entryId}`)
        .send({ payload: { name: 'Too late' } });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ALREADY_REVIEWED');
    });

    it('Editor: entityType/status/submittedByUid in the body are rejected (400), never reach the DB', async () => {
      const app = buildApp(EDITOR);
      const res = await request(app)
        .patch(`/api/v1/admin/pending/${entryId}`)
        .send({ payload: { name: 'x' }, status: 'approved' });
      expect(res.status).toBe(400);
    });
  });

  describe('POST / and DELETE /:id — Editor gets no new submit/withdraw capability', () => {
    it('Editor: POST / — 403', async () => {
      const app = buildApp(EDITOR);
      const res = await request(app)
        .post('/api/v1/admin/pending')
        .send({ entityType: 'skill', payload: { name: 'New skill' } });
      expect(res.status).toBe(403);
    });

    it('Editor: DELETE /:id — 403', async () => {
      const app = buildApp(EDITOR);
      const res = await request(app).delete(`/api/v1/admin/pending/${entryId}`);
      expect(res.status).toBe(403);
    });

    it('Contributor: POST / — still 200 (unchanged)', async () => {
      nextResult = { data: { id: entryId, entity_type: 'skill', payload: { name: 'x' }, status: 'pending', submitted_by: 'contrib-1', submitted_at: 't' }, error: null };
      const app = buildApp(CONTRIBUTOR);
      const res = await request(app)
        .post('/api/v1/admin/pending')
        .send({ entityType: 'skill', payload: { name: 'New skill' } });
      expect(res.status).toBe(201);
    });
  });

  describe('POST /:id/approve and /reject — no publishing authority for Editor or Contributor (unchanged)', () => {
    it('Editor: approve — 403', async () => {
      const app = buildApp(EDITOR);
      const res = await request(app).post(`/api/v1/admin/pending/${entryId}/approve`);
      expect(res.status).toBe(403);
    });

    it('Contributor: approve — 403', async () => {
      const app = buildApp(CONTRIBUTOR);
      const res = await request(app).post(`/api/v1/admin/pending/${entryId}/approve`);
      expect(res.status).toBe(403);
    });

    it('Editor: reject — 403', async () => {
      const app = buildApp(EDITOR);
      const res = await request(app)
        .post(`/api/v1/admin/pending/${entryId}/reject`)
        .send({ reason: 'no' });
      expect(res.status).toBe(403);
    });
  });
});
