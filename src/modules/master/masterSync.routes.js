'use strict';

/**
 * masterSync.routes.js — Manual Salary Sync Trigger (MASTER_ADMIN only)
 *
 * OBSERVABILITY UPGRADE: Writes to admin_logs on sync trigger.
 *
 * Routes:
 *   POST /api/v1/master/sync/trigger  → manually trigger salary API sync
 *   GET  /api/v1/master/sync/status   → last sync timestamp per provider
 */

const express            = require('express');
const { asyncHandler }   = require('../../utils/helpers');
const externalApiRepo    = require('./externalApi.repository');
const { logAdminAction } = require('../../utils/adminAuditLogger');
const logger             = require('../../utils/logger');

const router = express.Router();

router.post(
  '/trigger',
  asyncHandler(async (req, res) => {
    const adminId = req.user.uid;
    logger.info('[MasterSync] Manual sync triggered', { adminId });

    await logAdminAction({
      adminId,
      action:     'SALARY_SYNC_TRIGGERED',
      entityType: 'salary_data',
      metadata:   { triggeredBy: 'manual' },
      ipAddress:  req.ip,
    });

    // Lazy-load worker — avoids cron side effect on server startup
    setImmediate(async () => {
      try {
        const { runSalarySync } = require('../../workers/salaryApiSync.worker');
        await runSalarySync();
      } catch (err) {
        logger.error('[MasterSync] Manual sync failed', { error: err.message });
      }
    });

    return res.status(202).json({
      success: true,
      message: 'Salary sync triggered. Running in background.',
    });
  })
);

router.get(
  '/status',
  asyncHandler(async (req, res) => {
    const apis = await externalApiRepo.listAll();
    return res.status(200).json({
      success: true,
      data: apis.map(api => ({
        id:           api.id,
        providerName: api.providerName,
        enabled:      api.enabled,
        lastSync:     api.lastSync ?? null,
        rateLimit:    api.rateLimit,
      })),
      count: apis.length,
    });
  })
);

module.exports = router;








