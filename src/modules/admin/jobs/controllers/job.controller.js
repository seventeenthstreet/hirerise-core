'use strict';

/**
 * job.controller.js — HTTP handlers for Admin Jobs read endpoints.
 *
 * WP-ADMIN-COMP-06: no admin-facing read path existed for the "jobs" table
 * before this — the only previously-mounted route was POST /admin/jobs/sync
 * (write-only). These handlers add List/Detail/sync-status/sync-history,
 * all read-only, all backed by repository methods that either already
 * existed (syncLockRepository.getStatus, syncLogRepository.list) or are
 * new minimal additions matching the real "jobs" table schema
 * (job.repository.js list/findById — see that file's header for the exact
 * column evidence).
 *
 * Response envelope matches the existing HireRise convention (see
 * adminCmsSkills.controller.js): { success: true, data: {...} }.
 *
 * Authorization: inherited from the mount point in server.js —
 *   app.use(`${API_PREFIX}/admin/jobs`, authenticate, requireAdmin,
 *            requireElevatedSession, require('./modules/admin/jobs/adminJobs.routes'))
 * No route in this file re-derives or bypasses that chain.
 */

const { asyncHandler } = require('../../../../utils/helpers');
const { AppError, ErrorCodes } = require('../../../../middleware/errorHandler');
const jobRepository = require('../repositories/job.repository');
const syncLockRepository = require('../repositories/syncLock.repository');
const syncLogRepository = require('../repositories/syncLog.repository');

// ── GET /admin/jobs ──────────────────────────────────────────────────────────

const listJobs = asyncHandler(async (req, res) => {
  const { limit, offset, search, source } = req.query;

  const result = await jobRepository.list({
    limit: limit ? Math.min(parseInt(limit, 10), 100) : 20,
    offset: offset ? Math.max(parseInt(offset, 10), 0) : 0,
    search: search || undefined,
    source: source || undefined,
  });

  return res.status(200).json({
    success: true,
    data: { items: result.items, total: result.total },
  });
});

// ── GET /admin/jobs/:id ───────────────────────────────────────────────────────

const getJob = asyncHandler(async (req, res) => {
  const job = await jobRepository.findById(req.params.id);

  if (!job) {
    throw AppError.notFound('Job not found', ErrorCodes.NOT_FOUND, { id: req.params.id });
  }

  return res.status(200).json({ success: true, data: job });
});

// ── GET /admin/jobs/sync/status ───────────────────────────────────────────────

const getSyncStatus = asyncHandler(async (req, res) => {
  const status = await syncLockRepository.getStatus();
  return res.status(200).json({ success: true, data: status });
});

// ── GET /admin/jobs/sync/logs ─────────────────────────────────────────────────

const listSyncLogs = asyncHandler(async (req, res) => {
  const { limit } = req.query;
  const logs = await syncLogRepository.list({
    limit: limit ? Math.min(parseInt(limit, 10), 100) : 20,
  });

  return res.status(200).json({ success: true, data: { items: logs } });
});

module.exports = { listJobs, getJob, getSyncStatus, listSyncLogs };
