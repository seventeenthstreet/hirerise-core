'use strict';

/**
 * @file job.controller.test.js
 * @description WP-ADMIN-COMP-06 — Admin Jobs read endpoints.
 */

jest.mock('../../repositories/job.repository', () => ({
  list: jest.fn(),
  findById: jest.fn(),
}));

jest.mock('../../repositories/syncLock.repository', () => ({
  getStatus: jest.fn(),
}));

jest.mock('../../repositories/syncLog.repository', () => ({
  list: jest.fn(),
}));

const jobRepository = require('../../repositories/job.repository');
const syncLockRepository = require('../../repositories/syncLock.repository');
const syncLogRepository = require('../../repositories/syncLog.repository');
const { listJobs, getJob, getSyncStatus, listSyncLogs } = require('../job.controller');

function makeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

// asyncHandler (utils/helpers.js) wraps handlers as
// `Promise.resolve().then(() => fn(...)).catch(next)` without returning
// that promise, so `await handler(...)` resolves before the internal
// chain settles. Flush the microtask queue before asserting.
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('job.controller', () => {
  describe('listJobs', () => {
    it('returns items and total in the standard envelope', async () => {
      jobRepository.list.mockResolvedValue({ items: [{ id: '1' }], total: 1 });
      const req = { query: {} };
      const res = makeRes();

      await listJobs(req, res, jest.fn());
      await flush();

      expect(jobRepository.list).toHaveBeenCalledWith({
        limit: 20,
        offset: 0,
        search: undefined,
        source: undefined,
      });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: { items: [{ id: '1' }], total: 1 },
      });
    });

    it('clamps limit and passes through search/source', async () => {
      jobRepository.list.mockResolvedValue({ items: [], total: 0 });
      const req = { query: { limit: '9999', offset: '5', search: 'engineer', source: 'json' } };
      const res = makeRes();

      await listJobs(req, res, jest.fn());
      await flush();

      expect(jobRepository.list).toHaveBeenCalledWith({
        limit: 100,
        offset: 5,
        search: 'engineer',
        source: 'json',
      });
    });
  });

  describe('getJob', () => {
    it('returns the job when found', async () => {
      jobRepository.findById.mockResolvedValue({ id: 'job-1', title: 'Engineer' });
      const req = { params: { id: 'job-1' } };
      const res = makeRes();

      await getJob(req, res, jest.fn());
      await flush();

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ success: true, data: { id: 'job-1', title: 'Engineer' } });
    });

    it('propagates a 404 AppError when the job does not exist', async () => {
      jobRepository.findById.mockResolvedValue(null);
      const req = { params: { id: 'missing' } };
      const res = makeRes();
      const next = jest.fn();

      // getJob is wrapped in asyncHandler, which catches the thrown
      // AppError and forwards it to next() rather than letting it reject.
      await getJob(req, res, next);
      await flush();

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });
  });

  describe('getSyncStatus', () => {
    it('returns the current lock status', async () => {
      syncLockRepository.getStatus.mockResolvedValue({ lock_id: 'jobSync', status: 'idle' });
      const req = {};
      const res = makeRes();

      await getSyncStatus(req, res, jest.fn());
      await flush();

      expect(res.json).toHaveBeenCalledWith({ success: true, data: { lock_id: 'jobSync', status: 'idle' } });
    });
  });

  describe('listSyncLogs', () => {
    it('returns recent sync history', async () => {
      syncLogRepository.list.mockResolvedValue([{ id: 'log-1', total_records: 10 }]);
      const req = { query: {} };
      const res = makeRes();

      await listSyncLogs(req, res, jest.fn());
      await flush();

      expect(syncLogRepository.list).toHaveBeenCalledWith({ limit: 20 });
      expect(res.json).toHaveBeenCalledWith({ success: true, data: { items: [{ id: 'log-1', total_records: 10 }] } });
    });
  });
});
