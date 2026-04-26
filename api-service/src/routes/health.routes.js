'use strict';

import { Router } from 'express';
import crypto from 'crypto';
import { supabase } from '../../../config/supabaseClient.js';
import { logger } from '../../../shared/logger/index.js';
import { getMetricsSnapshot } from '../../../shared/monitoring/metrics.js';
import { sendAlert } from '../../../shared/monitoring/alerts.js';

export const healthRouter = Router();

const SERVICE_NAME = 'api-service';
const READINESS_TIMEOUT_MS = 1000;
const startedAt = new Date().toISOString();

/* ---------------- HELPERS ---------------- */

function getMemoryUsage() {
  const mem = process.memoryUsage();
  return {
    heapUsedMb: Number((mem.heapUsed / 1024 / 1024).toFixed(2)),
    heapTotalMb: Number((mem.heapTotal / 1024 / 1024).toFixed(2)),
    rssMb: Number((mem.rss / 1024 / 1024).toFixed(2)),
  };
}

function isHighMemory(mem) {
  return mem.heapUsedMb > 500; // adjust threshold
}

function createHealthPayload(req, extra = {}) {
  return {
    ...extra,
    timestamp: new Date().toISOString(),
    requestId: req?.requestId ?? null,
  };
}

function withTimeout(promise, ms) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error('Health check timeout'));
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

function safeCompare(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/* ---------------- /health ---------------- */

healthRouter.get('/', (req, res) => {
  const memory = getMemoryUsage();

  // optional: hide internals in production
  const base = {
    status: 'ok',
    service: SERVICE_NAME,
    environment: process.env.NODE_ENV ?? 'unknown',
    uptime: Math.floor(process.uptime()),
  };

  if (process.env.NODE_ENV !== 'production') {
    base.startedAt = startedAt;
    base.memory = memory;
    base.pid = process.pid;
  }

  return res.json(createHealthPayload(req, base));
});

/* ---------------- /health/ready ---------------- */

healthRouter.get('/ready', async (req, res) => {
  try {
    const { error } = await withTimeout(
      supabase.from('pg_tables').select('tablename').limit(1),
      READINESS_TIMEOUT_MS,
    );

    if (error) {
      logger.warn('Health readiness failed', {
        error: error.message,
        requestId: req.requestId,
      });

      await sendAlert({
        message: 'Database readiness failed',
        severity: 'critical',
        error,
        alertKey: 'health:db',
      }).catch(() => {});

      return res.status(503).json(
        createHealthPayload(req, {
          status: 'not_ready',
          dependency: 'database',
          db: 'disconnected',
        }),
      );
    }

    const memory = getMemoryUsage();

    // optional memory alert
    if (isHighMemory(memory)) {
      sendAlert({
        message: 'High memory usage detected',
        severity: 'high',
        context: memory,
        alertKey: 'health:memory',
      }).catch(() => {});
    }

    return res.json(
      createHealthPayload(req, {
        status: 'ready',
        db: 'connected',
        uptime: Math.floor(process.uptime()),
        ...(process.env.NODE_ENV !== 'production' ? { memory } : {}),
      }),
    );
  } catch (error) {
    logger.error('Health readiness exception', {
      error: error.message,
      requestId: req.requestId,
    });

    await sendAlert({
      message: 'Health readiness exception',
      severity: 'critical',
      error,
      alertKey: 'health:exception',
    }).catch(() => {});

    return res.status(503).json(
      createHealthPayload(req, {
        status: 'not_ready',
        dependency: 'database',
        db: 'disconnected',
      }),
    );
  }
});

/* ---------------- /health/live ---------------- */

healthRouter.get('/live', (req, res) => {
  return res.json(
    createHealthPayload(req, {
      status: 'live',
      service: SERVICE_NAME,
    }),
  );
});

/* ---------------- /health/metrics ---------------- */

healthRouter.get('/metrics', (req, res) => {
  const internalToken = process.env.INTERNAL_SERVICE_TOKEN;

  if (internalToken && process.env.NODE_ENV === 'production') {
    const provided = req.headers['x-internal-token'];

    if (!safeCompare(provided, internalToken)) {
      return res
        .status(403)
        .json({ error: 'FORBIDDEN', message: 'Internal endpoint' });
    }
  }

  return res.json(
    createHealthPayload(req, {
      status: 'ok',
      service: SERVICE_NAME,
      ...getMetricsSnapshot(),
    }),
  );
});