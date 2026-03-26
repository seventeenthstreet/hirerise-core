/**
 * api-service/src/routes/health.routes.js
 *
 * Routes (no auth required — used by load balancers and Cloud Run):
 *   GET /health        — Basic liveness check
 *   GET /health/ready  — Readiness check
 *   GET /health/live   — Liveness check (alias)
 */

import { Router } from 'express';

export const healthRouter = Router();

const startedAt = new Date().toISOString();

// GET /health
healthRouter.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'api-service',
    startedAt,
    uptime: Math.floor(process.uptime()),
  });
});

// GET /health/ready  — Kubernetes / Cloud Run readiness probe
healthRouter.get('/ready', (_req, res) => {
  res.json({ status: 'ready' });
});

// GET /health/live   — Kubernetes / Cloud Run liveness probe
healthRouter.get('/live', (_req, res) => {
  res.json({ status: 'live' });
});