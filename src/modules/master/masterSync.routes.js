'use strict';

/**
 * src/modules/master/masterSync.routes.js
 *
 * Manual Salary Sync Trigger (MASTER_ADMIN only)
 *
 * SUPABASE HARDENING:
 * - Preserves async background trigger behavior
 * - Keeps lazy worker loading
 * - Improves status field compatibility
 * - Adds stronger background error observability
 * - Keeps admin audit behavior unchanged
 */

const express = require('express');
const { asyncHandler } = require('../../utils/helpers');
const externalApiRepo = require('./externalApi.repository');
const { logAdminAction } = require('../../utils/adminAuditLogger');
const logger = require('../../utils/logger');

const router = express.Router();

/* ────────────────────────────────────────────────────────────────────────── */
/* POST /api/v1/master/sync/trigger */
/* ────────────────────────────────────────────────────────────────────────── */

router.post(
  '/trigger',
  asyncHandler(async (req, res) => {
    const adminId = req.user.uid;

    logger.info('[MasterSync] Manual sync triggered', {
      adminId,
      ipAddress: req.ip,
    });

    await logAdminAction({
      adminId,
      action: 'SALARY_SYNC_TRIGGERED',
      entityType: 'salary_data',
      metadata: {
        triggeredBy: 'manual',
      },
      ipAddress: req.ip,
    });

    /**
     * Lazy-load worker
     * Prevents cron/bootstrap side effects on server startup.
     *
     * setImmediate ensures API response is returned instantly.
     */
    setImmediate(async () => {
      try {
        const {
          runSalarySync,
        } = require('../../workers/salaryApiSync.worker');

        await runSalarySync();

        logger.info('[MasterSync] Manual sync completed', {
          adminId,
        });
      } catch (error) {
        logger.error('[MasterSync] Manual sync failed', {
          adminId,
          error: error.message,
          stack: error.stack,
        });
      }
    });

    return res.status(202).json({
      success: true,
      message: 'Salary sync triggered. Running in background.',
    });
  })
);

/* ────────────────────────────────────────────────────────────────────────── */
/* GET /api/v1/master/sync/status */
/* ────────────────────────────────────────────────────────────────────────── */

router.get(
  '/status',
  asyncHandler(async (req, res) => {
    const apis = await externalApiRepo.listAll();

    const data = apis.map((api) => ({
      id: api.id,
      providerName: api.providerName,
      enabled: Boolean(api.enabled),

      /**
       * Supabase-safe compatibility:
       * supports both repository-normalized and raw SQL rows
       */
      lastSync: api.lastSync ?? api.last_sync ?? null,

      rateLimit: api.rateLimit ?? null,
    }));

    return res.status(200).json({
      success: true,
      data,
      count: data.length,
    });
  })
);

module.exports = router;