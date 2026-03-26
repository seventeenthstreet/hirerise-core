'use strict';

/**
 * aiJobs.route.js — Client poll endpoint for async AI job status
 *
 * GET /api/v1/ai-jobs/:jobId
 *
 * Protected by auth token (authenticate middleware) — users can only
 * poll their own jobs (ownership enforced in getJobStatus).
 *
 * RESPONSES:
 *   pending/processing:
 *     200 { status: 'pending'|'processing', jobId, operationType }
 *
 *   completed:
 *     200 { status: 'completed', jobId, operationType, result: { ... } }
 *
 *   failed:
 *     200 { status: 'failed', jobId, operationType, error: { code, message } }
 *     NOTE: Returns 200, not 4xx/5xx — the poll succeeded; the job failed.
 *
 *   not found / not owned:
 *     404 — job not found (ownership check is silent 404)
 *
 * POLLING GUIDANCE (include in 202 response to clients):
 *   - Poll every 3-5 seconds for first 30 seconds
 *   - Poll every 10 seconds after that
 *   - Stop polling after 5 minutes (jobs should complete in < 60s)
 *   - A 'failed' status means the client should show an error + offer retry
 *
 * REGISTRATION (server.js):
 *   app.use(`${API_PREFIX}/ai-jobs`, authenticate, require('./routes/aiJobs.route'));
 *
 * @module routes/aiJobs.route
 */

const express = require('express');
const { getJobStatus } = require('../core/aiJobQueue');
const logger  = require('../utils/logger');

const router = express.Router();

router.get('/:jobId', async (req, res, next) => {
  try {
    const { jobId } = req.params;
    const userId    = req.user.uid;

    if (!jobId || typeof jobId !== 'string' || jobId.length > 64) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid jobId.' },
      });
    }

    const job = await getJobStatus(jobId, userId);

    logger.debug('[AIJobsRoute] Poll request', {
      userId, jobId, status: job.status,
    });

    return res.status(200).json({
      success: true,
      data:    job,
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;








