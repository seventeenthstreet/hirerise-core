import { Router } from 'express';
import { supabase } from '../../../config/supabaseClient.js';

export const healthRouter = Router();

const startedAt = new Date().toISOString();

// ─────────────────────────────────────────────────────────────────────────────
// GET /health — Basic status
// ─────────────────────────────────────────────────────────────────────────────

healthRouter.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'api-service',
    environment: process.env.NODE_ENV || 'unknown',
    startedAt,
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    requestId: req.requestId,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /health/ready — Readiness check
// ─────────────────────────────────────────────────────────────────────────────

healthRouter.get('/ready', async (req, res) => {
  try {
    // Check Supabase connectivity (lightweight query)
    const { error } = await withTimeout(
      supabase.from('jobs').select('id').limit(1),
      1000
    );

    if (error) {
      return res.status(503).json({
        status: 'not_ready',
        dependency: 'database',
        error: error.message,
        timestamp: new Date().toISOString(),
        requestId: req.requestId,
      });
    }

    return res.json({
      status: 'ready',
      timestamp: new Date().toISOString(),
      requestId: req.requestId,
    });

  } catch (err) {
    return res.status(503).json({
      status: 'not_ready',
      error: 'Dependency check failed',
      timestamp: new Date().toISOString(),
      requestId: req.requestId,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /health/live — Liveness check
// ─────────────────────────────────────────────────────────────────────────────

healthRouter.get('/live', (_req, res) => {
  res.json({ status: 'live' });
});

// ─────────────────────────────────────────────────────────────────────────────
// Timeout Helper
// ─────────────────────────────────────────────────────────────────────────────

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout')), ms)
    ),
  ]);
}