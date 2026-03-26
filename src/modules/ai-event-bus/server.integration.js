'use strict';

/**
 * server.integration.js — AIEventBus Integration for server.js
 *
 * This file shows EXACTLY what to add to core/src/server.js.
 * It is NOT a runnable file — it documents the two additions needed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ADDITION 1 — Register event bus routes (one line)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Find the section in server.js where routes are registered (look for lines like
 * `app.use(`${API_PREFIX}/job-seeker`, ...)`).
 *
 * Add this block AFTER the existing route registrations, before the
 * notFoundHandler and errorHandler:
 */

// ── AI Event Bus routes ───────────────────────────────────────────────────────
// Async pipeline: trigger-analysis, intelligence-report, jobs/matches,
// career/risk, career/opportunities, pipeline-status
// if (process.env.FEATURE_EVENT_BUS === 'true') {
//   app.use(API_PREFIX, authenticate,
//     require('./modules/ai-event-bus/routes/aiEventBus.routes'));
// }

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ADDITION 2 — Start BullMQ workers (feature-flagged)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Find the section at the BOTTOM of server.js where the HTTP server starts
 * (the `app.listen(PORT, ...)` block).
 *
 * Add this block BEFORE `app.listen(...)`:
 */

// ── AI Event Bus workers ──────────────────────────────────────────────────────
// Start BullMQ workers when event bus is enabled.
// Workers process queued jobs asynchronously.
// if (process.env.FEATURE_EVENT_BUS === 'true') {
//   const { startAll, stopAll } = require('./modules/ai-event-bus/workers');
//   startAll();
//
//   // Graceful shutdown — wait for in-flight jobs to complete
//   process.on('SIGTERM', async () => {
//     logger.info('[Server] SIGTERM received — stopping AI workers');
//     await stopAll();
//     await require('./modules/ai-event-bus/bus/aiEventBus').closeAllQueues();
//   });
// }

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ADDITION 3 — Hook CV_PARSED event into resume pipeline
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * In core/src/modules/resume/resume.service.js (or whichever service handles
 * CV parsing completion), add this after the parse result is saved:
 */

// ── Emit CV_PARSED event after successful parse ───────────────────────────────
// if (process.env.FEATURE_EVENT_BUS === 'true') {
//   try {
//     const bus = require('../ai-event-bus/bus/aiEventBus');
//     await bus.publish(bus.EVENT_TYPES.CV_PARSED, {
//       userId,
//       resumeId,
//       skills:     parsedResult.skills || [],
//       parsedData: parsedResult,
//     });
//     logger.info('[Resume] CV_PARSED event published', { userId });
//   } catch (err) {
//     // Non-fatal — existing synchronous flow continues
//     logger.warn('[Resume] Failed to publish CV_PARSED event', { err: err.message });
//   }
// }

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ENVIRONMENT VARIABLES
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Add to .env:
 *
 *   # Master feature flag — set false to keep existing synchronous behaviour
 *   FEATURE_EVENT_BUS=true
 *
 *   # Redis (already required for CACHE_PROVIDER=redis — no new vars needed)
 *   CACHE_PROVIDER=redis
 *   REDIS_HOST=127.0.0.1
 *   REDIS_PORT=6379
 *   REDIS_PASSWORD=...
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NPM PACKAGE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * One new dependency — BullMQ:
 *
 *   npm install bullmq
 *
 * BullMQ uses ioredis internally. The project already has ioredis in
 * package.json ("ioredis": "^5.9.3") so no ioredis version conflict.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FOLDER STRUCTURE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * src/modules/ai-event-bus/
 *   bus/
 *     aiEventBus.js                 ← core event publisher
 *   queues/
 *     queue.config.js               ← queue names, options, event→queue routing
 *   workers/
 *     baseWorker.js                 ← abstract base class
 *     index.js                      ← all 6 workers + startAll/stopAll
 *   results/
 *     intelligenceResults.service.js ← dashboard result reader
 *   routes/
 *     aiEventBus.routes.js          ← all API endpoints
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ROLLOUT SEQUENCE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   Step 1:  npm install bullmq
 *   Step 2:  Run migration: psql $DATABASE_URL -f migrations/003_ai_event_bus.sql
 *   Step 3:  Deploy with FEATURE_EVENT_BUS=false (routes exist, workers don't start)
 *   Step 4:  Verify routes respond (health check)
 *   Step 5:  Set FEATURE_EVENT_BUS=true on one instance (canary)
 *   Step 6:  Monitor BullMQ queues via Redis CLI: KEYS hirerise:*
 *   Step 7:  Full rollout once canary is stable
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MONITORING — check queue depths in Redis
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   redis-cli KEYS "hirerise:*"
 *   redis-cli LLEN "bull:hirerise:job-matching:queue:wait"
 *   redis-cli LLEN "bull:hirerise:career-advisor:queue:wait"
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * BACKWARD COMPATIBILITY
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The existing synchronous endpoints are UNTOUCHED:
 *   POST /api/v1/chi-v2/full-intelligence  — still works, returns immediately
 *   GET  /api/v1/job-seeker/jobs/match      — still works, returns immediately
 *   GET  /api/v1/career/advice              — still works, returns immediately
 *
 * New async endpoints sit alongside them. Frontend can choose which to use:
 *   - Use synchronous for low-latency single operations
 *   - Use async pipeline for full background refresh after CV upload
 */

module.exports = {};









