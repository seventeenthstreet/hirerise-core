'use strict';

import { Router } from 'express';
import { supabase } from '../../../config/supabaseClient.js';
import { logger } from '../../../shared/logger/index.js';

export const healthRouter = Router();

const SERVICE_NAME = 'api-service';
const READINESS_TIMEOUT_MS = 1000;
const startedAt = new Date().toISOString();

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// GET /health — Basic status
// ─────────────────────────────────────────────────────────────────────────────

healthRouter.get('/', (req, res) => {
  return res.json(
    createHealthPayload(req, {
      status: 'ok',
      service: SERVICE_NAME,
      environment: process.env.NODE_ENV ?? 'unknown',
      startedAt,
      uptime: Math.floor(process.uptime()),
    }),
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /health/ready — Readiness check
// ─────────────────────────────────────────────────────────────────────────────

healthRouter.get('/ready', async (req, res) => {
  try {
    const { data, error } = await withTimeout(
      supabase.rpc('health_check'),
      READINESS_TIMEOUT_MS,
    );

    if (error || data !== true) {
      logger.warn('Health readiness failed', {
        error: error?.message ?? 'Unexpected RPC response',
        requestId: req.requestId,
      });

      return res.status(503).json(
        createHealthPayload(req, {
          status: 'not_ready',
          dependency: 'database',
          error: error?.message ?? 'Health RPC failed',
        }),
      );
    }

    return res.json(
      createHealthPayload(req, {
        status: 'ready',
      }),
    );
  } catch (error) {
    logger.error('Health readiness exception', {
      error: error.message,
      requestId: req.requestId,
    });

    return res.status(503).json(
      createHealthPayload(req, {
        status: 'not_ready',
        dependency: 'database',
        error: error.message,
      }),
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /health/live — Liveness check
// ─────────────────────────────────────────────────────────────────────────────

healthRouter.get('/live', (req, res) => {
  return res.json(
    createHealthPayload(req, {
      status: 'live',
      service: SERVICE_NAME,
    }),
  );
});