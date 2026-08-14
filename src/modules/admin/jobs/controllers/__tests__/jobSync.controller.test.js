'use strict';

/**
 * @file jobSync.controller.test.js
 * @description WP-ADMIN-COMP-06-R2 regression tests.
 *
 * Covers uploadJobsCsv — the new POST /admin/jobs/sync/upload handler —
 * asserting it shares syncJobs()'s auth checks, service delegation
 * pattern, lock-conflict (409) handling, and response envelope, per the
 * "reuse existing pipeline, do not create a second architecture"
 * requirement.
 */

jest.mock('../../services/jobSync.service', () => ({
  syncJobs: jest.fn(),
  syncJobsFromCsvUpload: jest.fn(),
}));

jest.mock('../../../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const jobSyncService = require('../../services/jobSync.service');
const { uploadJobsCsv } = require('../jobSync.controller');

function makeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function makeReq(overrides = {}) {
  return {
    headers: {},
    user: { id: 'admin-1' },
    body: {},
    file: {
      buffer: Buffer.from('jobCode,title,company,location,type\nENG-1,Engineer,Acme,Remote,full_time'),
      originalname: 'jobs.csv',
    },
    ...overrides,
  };
}

describe('jobSync.controller — uploadJobsCsv', () => {
  it('rejects with 400 when no file is attached', async () => {
    const req = makeReq({ file: undefined });
    const res = makeRes();
    const next = jest.fn();

    await uploadJobsCsv(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(jobSyncService.syncJobsFromCsvUpload).not.toHaveBeenCalled();
  });

  it('rejects with 401 when there is no authenticated admin', async () => {
    const req = makeReq({ user: undefined, auth: undefined });
    const res = makeRes();
    const next = jest.fn();

    await uploadJobsCsv(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(jobSyncService.syncJobsFromCsvUpload).not.toHaveBeenCalled();
  });

  it('delegates to jobSyncService.syncJobsFromCsvUpload with the uploaded buffer and filename', async () => {
    jobSyncService.syncJobsFromCsvUpload.mockResolvedValue({
      total: 1, success: 1, failed: 0, errors: [],
    });

    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await uploadJobsCsv(req, res, next);

    expect(jobSyncService.syncJobsFromCsvUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        csvBuffer: req.file.buffer,
        fileName: 'jobs.csv',
        initiatedBy: 'admin-1',
      })
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: { total: 1, success: 1, failed: 0, errors: [] },
      })
    );
  });

  it('returns the same partial-success (207-equivalent 200/422) shape as syncJobs()', async () => {
    jobSyncService.syncJobsFromCsvUpload.mockResolvedValue({
      total: 10, success: 9, failed: 1, errors: [{ jobCode: 'ENG-2', message: 'title is required' }],
    });

    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await uploadJobsCsv(req, res, next);

    // total=10, success=9, failed=1 → not "all failed", so 200 with success:false is NOT
    // triggered by the 422 branch (failed>0 && success===0) — mirrors syncJobs()'s exact rule.
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Job sync complete. 9 succeeded, 1 failed out of 10 records.',
        data: expect.objectContaining({ total: 10, success: 9, failed: 1 }),
      })
    );
  });

  it('returns 422 when every record fails, matching syncJobs()', async () => {
    jobSyncService.syncJobsFromCsvUpload.mockResolvedValue({
      total: 3, success: 0, failed: 3, errors: [],
    });

    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await uploadJobsCsv(req, res, next);

    expect(res.status).toHaveBeenCalledWith(422);
  });

  // Regression test for the "Unexpected server response" bug: a 422 body
  // that is only { success:false, message, data } matches none of the
  // shapes front/src/lib/api/core/api-parser.ts's parseBackendError()
  // recognises as an error, so it fell through to its generic fallback
  // message and the admin never saw the real per-record errors. Every
  // non-200 response from sendSyncResult must also carry a V2-shaped
  // `error: { code, message, details }` object.
  it('includes a V2-shaped error object (code/message/details) whenever the response is not 200', async () => {
    const errors = [{ jobCode: 'ENG-2', message: 'type must be one of: full_time, part_time, contract, internship, remote' }];
    jobSyncService.syncJobsFromCsvUpload.mockResolvedValue({
      total: 1, success: 0, failed: 1, errors,
    });

    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await uploadJobsCsv(req, res, next);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          code:    expect.any(String),
          message: expect.any(String),
          details: expect.objectContaining({ total: 1, success: 0, failed: 1, errors }),
        }),
      })
    );
  });

  it('omits the error object on a 200 (full or partial success)', async () => {
    jobSyncService.syncJobsFromCsvUpload.mockResolvedValue({
      total: 1, success: 1, failed: 0, errors: [],
    });

    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await uploadJobsCsv(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.error).toBeUndefined();
  });

  it('returns 409 on a sync-lock conflict, same as syncJobs()', async () => {
    const lockErr = new Error('Another sync is already running');
    lockErr.statusCode = 409;
    jobSyncService.syncJobsFromCsvUpload.mockRejectedValue(lockErr);

    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await uploadJobsCsv(req, res, next);

    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('forwards unexpected errors to next()', async () => {
    const boom = new Error('unexpected');
    jobSyncService.syncJobsFromCsvUpload.mockRejectedValue(boom);

    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await uploadJobsCsv(req, res, next);

    expect(next).toHaveBeenCalledWith(boom);
  });
});
