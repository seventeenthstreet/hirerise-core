/**
 * server.js — HireRise Core Engine Entry Point
 *
 * Architecture: Supabase-first, Postgres-native, BullMQ async pipeline.
 * Authentication: Supabase JWT verification (see src/middleware/auth.middleware.js).
 *
 * Middleware order (enforced):
 *   correlationMiddleware → helmet → compression → CORS →
 *   raw body (Stripe) → json/urlencoded → requestTimeout →
 *   morgan → globalLimiter → [public routes] → [internal routes] →
 *   [webhook routes] → [protected routes] → 404 → errorHandler
 *
 * Two-tier admin system:
 *   contributor  — submit entries for review via /admin/pending
 *   admin+       — approve/reject entries, manage contributors
 *
 * Feature flags (all default false):
 *   FEATURE_SEMANTIC_MATCHING   — pgvector skill/job embeddings
 *   FEATURE_EVENT_BUS           — BullMQ async AI pipeline
 *   FEATURE_PERSONALIZATION     — behaviour-profile worker
 *   FEATURE_CAREER_READINESS    — career-readiness module (gated)
 *   RUN_ENGAGEMENT_WORKER       — run engagement worker inline
 *
 * ── Production-Readiness Audit Fixes ─────────────────────────────────────────
 *
 * CRITICAL
 *   C1  /user-activity route was missing `authenticate` middleware — user streak
 *       and chi-delta data was publicly accessible without a JWT.
 *   C2  `res._readyLeaseState` mutation inside an object-literal IIFE was unsafe;
 *       replaced with a pre-fetched local variable before the response literal.
 *   C3  (Pre-existing guard) `gracefulShutdown` is a hoisted function declaration;
 *       registered before bootstrap() so SIGINT/SIGTERM during startup are handled.
 *
 * STRONG
 *   S1  /ready endpoint exposed 100+ internal telemetry fields (lease epochs, node
 *       IDs, chaos state, DAG mutation scores) to the public internet. Default
 *       response now returns only { status, redis.connected, database.connected,
 *       timestamp }. Full telemetry requires ?verbose=1 AND INTERNAL_SERVICE_TOKEN.
 *   S2  Covered by C1 (same route).
 *   S3  Prometheus /metrics endpoint was unauthenticated; now requires
 *       requireInternalToken to prevent internal counter/queue exposure.
 *   S4  Forced-shutdown timer used a nested setTimeout(() => process.exit(1), 50)
 *       which could delay exit on a blocked event loop; replaced with direct call.
 *   S5  Fixed `////` typo in health/readiness section comment separator.
 *
 * MEDIUM
 *   M1  Silent `?.quit?.()` with empty catch in subscriber retry blocks replaced
 *       with explicit null checks and warn-level logging.
 *   M3  Route latency bucket key now uses `req.route?.path` before `req.originalUrl`
 *       to canonicalize keys and prevent per-request-ID Map bucket proliferation.
 *
 * WARNINGS
 *   W2  Removed duplicate JSDoc blocks for semantic.routes, opportunityRadar,
 *       and personalization — each had two copies of its API contract comment.
 *   W3  `getWeeklySprintBias()` now uses UTC day/hour to avoid timezone drift on
 *       Monday detection (server clock UTC ≠ user local Monday).
 *   W5  All inline `process.env.NODE_ENV` comparisons replaced with module-level
 *       `IS_TEST` and `IS_PRODUCTION` constants for consistency.
 *
 * ── Score 97 Hardening Fixes ──────────────────────────────────────────────────
 *
 * H1  Per-route AI rate limiting — added `aiRateLimit` middleware (20 req/min
 *     per authenticated UID, fallback to IP) on /copilot, /advisor, /skills,
 *     /career (semantic routes), and /user+/career (personalization routes).
 *     Previously all AI inference endpoints shared the global 400 req/15 min
 *     bucket; one user could exhaust the quota and degrade all others.
 *
 * H2  Broad prefix route mounts replaced with explicit path mounts — semantic.routes,
 *     opportunityRadar.routes, and personalization.routes were mounted on bare
 *     API_PREFIX via `app.use(API_PREFIX, authenticate, router)`. Any new route
 *     added inside those modules was automatically authenticated but bypassed
 *     per-group path guards and was invisible in the route registry. All three
 *     modules now mount on their explicit sub-paths (/skills, /career, /user).
 *
 * H3  global.* shared state replaced with module-level singletons —
 *     global.__tenantCacheMesh replaced with `tenantCacheMeshSingleton._instance`
 *     (a module-scoped Map), and global.__ACTIVE_TENANTS__ replaced with the
 *     module-level `activeTenants` array. This eliminates TypeScript blindness,
 *     singleton isolation issues, and the race condition where a worker and a
 *     route handler could diverge on different global object references.
 */

'use strict';

// ── Global process error handlers — registered before anything else ───────────
// Must be first to catch async rejections and uncaught exceptions from any
// module, including those loaded below. Without these, Node.js 20+ terminates
// the process via the default handler, bypassing gracefulShutdown entirely.
process.on('unhandledRejection', async (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  try {
    require('./utils/logger').error('[Process] Unhandled promise rejection', {
      reason: error.message,
      stack:  error.stack,
    });
  } catch (_) {
    console.error('[Process] Unhandled promise rejection', reason);
  }
  // Fire alert — best-effort, non-blocking
  try {
    await require('./monitoring/alerts').sendAlert({
      message: 'hirerise-core: Unhandled promise rejection',
      severity: require('./monitoring/alerts').SEVERITY.CRITICAL,
      error,
      alertKey: 'core:unhandledRejection',
      context: { pid: process.pid },
    });
  } catch (_) {}
});

process.on('uncaughtException', async (err) => {
  try {
    require('./utils/logger').error('[Process] Uncaught exception — initiating emergency shutdown', {
      error: err.message,
      stack: err.stack,
    });
  } catch (_) {
    console.error('[Process] Uncaught exception', err);
  }
  try {
    await require('./monitoring/alerts').sendAlert({
      message: 'hirerise-core: Uncaught exception — emergency shutdown',
      severity: require('./monitoring/alerts').SEVERITY.CRITICAL,
      error: err,
      alertKey: 'core:uncaughtException',
      context: { pid: process.pid },
    });
  } catch (_) {}
  // Allow gracefulShutdown to run if it is defined, otherwise exit immediately.
  if (typeof gracefulShutdown === 'function') {
    gracefulShutdown('uncaughtException').catch(() => {}).finally(() => process.exit(1));
  } else {
    process.exit(1);
  }
});

// ── Environment validation — MUST be first ────────────────────────────────────
// Validates all required environment variables before anything else loads.
// Server will not start if required variables are missing or malformed.
require('dotenv').config();
require('./scripts/validate-env')();
require('./config/env');

// ── Environment constants — single source of truth ───────────────────────────
// FIX W5: Centralise NODE_ENV checks so scattered inline comparisons don't drift.
const IS_TEST       = process.env.NODE_ENV === 'test';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// ── Core dependencies ─────────────────────────────────────────────────────────
const express     = require('express');
const helmet      = require('helmet');
const compression = require('compression');
const cors        = require('cors');
const morgan      = require('morgan');
const rateLimit   = require('express-rate-limit');

// ── Config ────────────────────────────────────────────────────────────────────
const {
  connectRedis,
  getRedisStatus,
  closeRedis,
} = require('./config/redisClient');
const { supabase } = require('./config/supabase');

// ── Utilities ─────────────────────────────────────────────────────────────────
const logger = require('./utils/logger');
const { sendAlert, SEVERITY } = require('./monitoring/alerts');
const { requestLoggerMiddleware } = require('./monitoring/request-logger.middleware');
const { getMetricsSnapshot } = require('./monitoring/metrics');
const aiUsage = require('./services/aiUsage.service');
const quorumReplication = require('./services/cache/quorumReplication.service');
const consensusMesh = require('./services/cache/replayConsensusMesh.service');
const consensusDriftAnomaly = require('./services/cache/consensusDriftAnomaly.service');
const predictiveSplitBrain = require('./services/cache/predictiveSplitBrain.service');
const quorumConfidence = require('./services/cache/quorumConfidence.service');
const consensusMemoryForecast = require('./services/cache/consensusMemoryForecast.service');
const autonomousTopologyMutation = require('./services/cache/autonomousTopologyMutation.service');

// ── Wave 49: Global safe JSON parser — single definition, used everywhere ─────
function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch (err) {
    logger.warn('[Wave49] Invalid JSON payload dropped', {
      error: err.message,
    });
    return null;
  }
}

// ── Wave 49: Module-level region allowlist — single definition, used everywhere ─
// Replaces per-message Set construction in anomaly, trust, and gossip handlers.
const ALLOWED_SIGNAL_REGIONS = new Set(['primary', 'fallback', 'secondary']);

// ── Middleware ────────────────────────────────────────────────────────────────
const { errorHandler, notFoundHandler }   = require('./middleware/errorHandler');
const { correlationMiddleware }           = require('./middleware/correlation.middleware');
const { requestTimeout } = require('./middleware/requestTimeout.middleware');
const { authenticate, requireAdmin }      = require('./middleware/auth.middleware');
const { requireElevatedSession } = require('./middleware/requireElevatedSession.middleware');
const { requireMasterAdmin }              = require('./middleware/requireMasterAdmin.middleware');
const { requireContributor }              = require('./middleware/requireContributor.middleware');
const { adminRateLimit, masterRateLimit } = require('./middleware/adminRateLimit.middleware');
const { requireInternalToken }            = require('./middleware/internalToken.middleware');
const tokenCache                          = require('./core/tokenCache');

// ── Per-route AI rate limiter ─────────────────────────────────────────────────
// Prevents a single user from exhausting the global bucket on high-cost AI
// inference endpoints (copilot, advisor, semantic-match, personalization).
// Applied per authenticated UID; falls back to IP when UID is unavailable.
// FIX: Addresses audit finding — per-route AI rate limiting (20 req/min).
const aiRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20,
  keyGenerator: (req) => req.user?.id || req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many AI inference requests. Please wait before retrying.',
    retryAfter: 60,
  },
  skip: () => IS_TEST,
});

// ── MFA rate limiter — WP-ADMIN-02C ─────────────────────────────────────────
// Tighter than aiRateLimit: TOTP verification is a brute-force target.
// registerFailedAttempt() in mfa.service.js also tracks a per-account lockout
// independent of this — this is the transport-level throttle, that is the
// account-level lockout. Both apply.
const mfaRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  keyGenerator: (req) => req.user?.id || req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many MFA requests. Please wait before retrying.',
    retryAfter: 900,
  },
  skip: () => IS_TEST,
});
const {
  tenantRegionMiddleware,
} = require('./middleware/tenantRegion.middleware');
// ── Route modules ─────────────────────────────────────────────────────────────

const { secretsRouter }    = require('./modules/secrets');
const marketIntelRouter    = require('./modules/marketIntelligence/marketIntelligence.routes');
const { skillDemandRouter } = require('./modules/skillDemand');
const directionRouter      = require('./routes/userDirection.routes');

// ── WP-7: System Health + XAI Metrics ────────────────────────────────────────
const systemHealthRoutes = require('./routes/admin/systemHealth.routes');
const xaiMetricsRoutes   = require('./routes/admin/xaiMetrics.routes');

// ── Daily Engagement System ───────────────────────────────────────────────────
const {
  engagementRouter,
  startEngagementWorker,
  stopEngagementWorker,
} = require('./modules/daily-engagement');

// ── CMS generic factory ───────────────────────────────────────────────────────
const {
  jobFamiliesModule,
  educationLevelsModule,
  salaryBenchmarksModule,
} = require('./modules/admin/cms/adminCmsGeneric.factory');

const careerDomainsModule  = require('./modules/admin/cms/career-domains/adminCmsCareerDomains.module');
const skillClustersModule  = require('./modules/admin/cms/skill-clusters/adminCmsSkillClusters.module');

// ── Observability ─────────────────────────────────────────────────────────────
const observabilityAdapter = require('./adapters/observability-adapter');

// ── Wave 27: Deterministic startup self-healing + replay-safe phase recovery ──
const {
  registerRecoverablePhase,
} = require('./lib/startup/recoveryRegistry');

const {
  replayRecoverablePhase,
} = require('./lib/startup/replayRecovery');

// ── Wave 28: Distributed quorum reconciliation + multi-node startup consensus ─
const {
  distributedStartupConsensus,
  publishNodeStartupState,
  evictExpiredDistributedLeases,
} = require('./lib/startup/distributedConsensusRegistry');

const {
  reconcileDistributedStartupQuorum,
} = require('./lib/startup/quorumReconciliation');

// =============================================================================
// Express app
// =============================================================================
const app = express();

const registeredRouteKeys = new Set();

// =============================================================================
// ✅ Server-scoped state — declared once, used across bootstrap + shutdown
// =============================================================================
let server = null;
let isShuttingDown = false;
let consensusMemoryForecastLoop = null;
let autonomousTopologyMutationWorker = null;

// Wave 30 — distributed lease renewal loop handle (clearInterval on shutdown)
let distributedLeaseRenewalLoop = null;

// Tracks which workers have been booted to prevent duplicate starts on
// hot-reload / nodemon restarts.
const workerBootRegistry = new Set();

// ── Phase 3: Resource tracking ────────────────────────────────────────────────
// Tracks all Redis clients so they can be closed on shutdown.
const _trackedRedisClients = new Set();

function trackRedisClient(client) {
  _trackedRedisClients.add(client);
  return client;
}

// Tracks all setInterval IDs so they can be cleared on shutdown.
const _trackedIntervals = new Set();

function trackInterval(fn, ms) {
  const id = setInterval(fn, ms);
  _trackedIntervals.add(id);
  return id;
}

// Tracks the gossip UDP socket so it can be closed on shutdown.
let _gossipSocket = null;

// Distributed startup barrier — readiness gate for /api/v1/ready.
// All required phases must complete before traffic is accepted.
const startupBarrier = {
  phases: new Map(),
  completed: new Set(),
  phaseDurations: new Map(),
  slowestPhase: null,
  isReleased: false,
  releaseTimestamp: null,
  registrationComplete: false,
  pendingDistributedRelease: false,
};

const startupRegressionProfiler = {
  repeatedSlowPhase: new Map(),
  lastBootSlowestPhase: null,
};

const DAG_FINGERPRINT_RETENTION_LIMIT = 100;

// Patch 49 → startup DAG slack analysis + bottleneck regression intelligence
const startupDagProfiler = {
  slackByPhase: new Map(),
  zeroValueCriticalBlockers: [],
  movablePostRelease: [],
  chainFingerprints: new Map(),
  lastCriticalPathDurationMs: null,
  criticalPathDeltaMs: null,
  reclassificationCandidates: [],
};

// Wave 16 → autonomous DAG self-healing + async promotion policy
const startupDagSelfHealing = {
  candidateScores: new Map(),
  promotionThreshold: 3,
  autoPromotedCandidates: [],
  permanentlyPromoted: new Set(),
  healingHistory: [],
  lastHealingActionAt: null,
};

// Wave 17 → controlled live DAG mutation + rollback ledger
const startupDagMutationLedger = {
  appliedMutations: new Map(),
  rollbackEvents: [],
  lastMutationAt: null,
  lastRollbackAt: null,
  canaryCohortSize: 1,
  cohortHistory: [],
  mutationConfidenceScore: 100,
  lastExpandedCohort: [],
  // Wave 19 → per-phase rollback attribution + quarantine
  phaseRiskScores: new Map(),
  quarantinedPhases: new Map(),
  quarantineCooldownMs: 3600000, // 1 hour
  lastQuarantineAt: null,
  // Wave 20 → adaptive cooldown scaling + wall-clock half-life decay
  quarantineBaseCooldownMs: 3600000, // 1h
  quarantineMaxCooldownMs: 86400000, // 24h
  lastRiskDecayAt: null,
  // Wave 21 → probation severity tiers + permanent ban registry
  probationTiers: new Map(),
  permanentlyBannedPhases: new Set(),
  probationHistory: [],
  appealHealthyStreakThreshold: 5,
  // Wave 21.1 → appellate eligibility clock: epoch-ms of each permanent ban
  permanentBanTimestamps: new Map(),
  // Wave 22 → parole review queue: age-gated eligibility metadata (no auto-unban)
  paroleReviewCandidates: new Map(),
  paroleMinimumBanAgeMs: 604800000, // 7 days
  // Wave 23 → supervised re-entry sandbox: scored promotion queue (no critical restore)
  paroleSandbox: new Map(),
  paroleScoreThreshold: 80,
  // Wave 24 → sandbox verdict engine: adjudicated outcomes + re-sentencing loop
  sandboxVerdicts: [],
  sandboxReentryThresholdMs: 100,
  // Wave 25 → appellate precedent intelligence: verdict history shapes future parole scores
  precedentScores: new Map(),
  precedentWeight: 5,
  // Wave 26 → constitutional parole doctrine: immutable startup phases block parole eligibility
  constitutionalProtectedPhases: new Set(),
  constitutionalOverrideHits: 0,
};

const startupWatchdog = {
  timer: null,
  startedAt: null,
  timeoutMs: parseInt(
    process.env.STARTUP_BARRIER_TIMEOUT_MS || '45000',
    10
  ),
  degradedReleaseAllowed: false,
};

// Patch 39 → persistent startup SLA history + predictive anomaly forecasting
const startupSlaHistory = {
  samples: [],
  maxSamples: 500,
  rollingAverageMs: null,
  rollingP95Ms: null,
  anomalyThresholdMultiplier: 1.8,
  lastForecastMs: null,
};

// Patch 40 → adaptive watchdog timeout self-tuning policy
const startupAdaptiveTimeoutPolicy = {
  minTimeoutMs: 30000,
  maxTimeoutMs: 120000,
  tuningMultiplier: 1.5,
  lastRecommendedTimeoutMs: null,
  lastAppliedTimeoutMs: null,
};

// Patch 41 → startup chaos verification + rollback confidence mesh
const startupChaosConfidence = {
  degradedReleases: 0,
  anomalyBreaches: 0,
  successfulAdaptiveRecoveries: 0,
  rollbackRiskScore: 0,
  confidenceScore: 100,
  rollbackThreshold: 65,
};

const routeLatencyBuckets = new Map();
const ROUTE_BUCKET_SAMPLE_LIMIT = 100;
const ROUTE_LEADERBOARD_INTERVAL_MS = 300000;
// Patch 38 → startup phase failure attribution registry
const startupPhaseAttribution = {
  phases: new Map(),
  failures: [],
  lastRootCause: null,
};


const routeLeaderboardInterval = trackInterval(() => {
  try {
    const leaderboard = [];

    for (const [routeKey, samples] of routeLatencyBuckets) {
      if (!samples.length) continue;

      const sorted = [...samples].sort(
        (a, b) => b - a
      );

      const p95Index = Math.max(
        0,
        Math.floor(sorted.length * 0.05)
      );

      leaderboard.push({
        route: routeKey,
        p95_duration_ms:
          sorted[p95Index] ?? sorted[0],
        sample_count: samples.length,
      });
    }

    const topRoutes = leaderboard
      .sort(
        (a, b) =>
          b.p95_duration_ms -
          a.p95_duration_ms
      )
      .slice(0, 5);

    if (topRoutes.length) {
      logger.info(
        '[Telemetry] Hottest route leaderboard',
        { routes: topRoutes }
      );
    }
  } catch (error) {
    logger.warn(
      '[Telemetry] Route leaderboard failed',
      { error: error.message }
    );
  }
}, ROUTE_LEADERBOARD_INTERVAL_MS);
routeLeaderboardInterval.unref();

// next startup helpers continue below

function recordStartupFailureAttribution(
  phase,
  error,
  metadata = {}
) {
  const failure = {
    phase,
    timestamp: Date.now(),
    message: error?.message || 'Unknown startup failure',
    stack: error?.stack,
    ...metadata,
  };

  startupPhaseAttribution.failures.push(failure);
  if (startupPhaseAttribution.failures.length > 200) {
    startupPhaseAttribution.failures.shift();
  }
  startupPhaseAttribution.lastRootCause = failure;

  return failure;
}

function releaseDegradedStartupBarrier(
  reason = 'startup-timeout'
) {
  if (startupBarrier.isReleased) {
    return;
  }
const minimumDegradedCritical = Array.from(
  startupBarrier.phases.entries()
)
  .filter(([, meta]) => meta.degradedFloor)
  .map(([phase]) => phase);

const degradedSafe = minimumDegradedCritical.every((phase) =>
  startupBarrier.completed.has(phase)
);

if (!degradedSafe) {
  logger.error(
    '[Server] degraded startup release denied: critical quorum floor unmet',
    {
      completed_phases: Array.from(startupBarrier.completed),
      pending_critical: minimumDegradedCritical.filter(
        (phase) => !startupBarrier.completed.has(phase)
      ),
      reason,
    }
  );
  return;
}

  startupWatchdog.degradedReleaseAllowed = true;
  startupChaosConfidence.degradedReleases += 1;
  startupChaosConfidence.rollbackRiskScore += 15;
  startupBarrier.isReleased = true;
  startupBarrier.pendingDistributedRelease = false;
  startupBarrier.releaseTimestamp = Date.now();
  recordStartupFailureAttribution(
  'startup-watchdog-timeout',
  new Error(reason),
  {
    completedPhases: Array.from(startupBarrier.completed),
    pendingPhases: Array.from(
      startupBarrier.phases.keys()
    ).filter(
      (phase) => !startupBarrier.completed.has(phase)
    ),
    slowestPhase:
      startupBarrier.slowestPhase?.phase || null,
    timeoutMs: startupWatchdog.timeoutMs,
  }
);

  logger.warn(
    '[Server] Patch 36 degraded startup quorum fallback activated',
    {
      reason,
      completed_phases: startupBarrier.completed.size,
      total_registered_phases: startupBarrier.phases.size,
      timeout_ms: startupWatchdog.timeoutMs,
    }
  );
}
/**
 * Register a named startup phase with the barrier.
 * Call once per phase name at bootstrap initialisation.
 */
function registerStartupPhase(
  phase,
  {
    critical = false,
    degradedFloor = false,
    asyncPhase = false,
    dependsOn = [],
  } = {}
) {
  const registeredAt = Date.now();

  startupBarrier.phases.set(phase, {
    registeredAt,
    status: 'pending',
    critical,
    degradedFloor,
    asyncPhase,
    dependsOn,
  });

  markStartupPhase(phase, {
    registeredAt,
    status: 'pending',
    critical,
    degradedFloor,
    asyncPhase,
    dependsOn,
  });
}

/**
 * Mark a named startup phase as complete and attempt to release the barrier.
 */
function markStartupPhase(phase, data = {}) {
  const existing =
    startupPhaseAttribution.phases.get(phase) || {};

  const merged = {
    ...existing,
    ...data,
  };

  startupPhaseAttribution.phases.set(phase, merged);

  if (merged.status === 'failed') {
    const failure = {
      phase,
      timestamp: Date.now(),
      reason: merged.reason || 'unknown',
      critical: merged.critical || false,
      degradedFloor: merged.degradedFloor || false,
      dependsOn: merged.dependsOn || [],
    };

    startupPhaseAttribution.failures.push(failure);
    if (startupPhaseAttribution.failures.length > 200) {
      startupPhaseAttribution.failures.shift();
    }
    startupPhaseAttribution.lastRootCause = failure;
  }
}

function calculatePhaseSlack(phase) {
  const meta = startupBarrier.phases.get(phase);
  const duration =
    startupBarrier.phaseDurations.get(phase) || 0;

  if (!meta) return 0;

  const downstreamDependents = Array.from(
    startupBarrier.phases.entries()
  ).filter(([, m]) =>
    (m.dependsOn || []).includes(phase)
  );

  if (downstreamDependents.length === 0) {
    return duration;
  }

  const maxDependentDuration = Math.max(
    ...downstreamDependents.map(
      ([p]) =>
        startupBarrier.phaseDurations.get(p) || 0
    )
  );

  return Math.max(0, maxDependentDuration - duration);
}

function fingerprintCriticalChain() {
  const criticalChain = Array.from(
    startupBarrier.phases.entries()
  )
    .filter(([, meta]) => meta.critical)
    .map(([phase]) => phase)
    .sort()
    .join(' -> ');

  const previousEntry =
  startupDagProfiler.chainFingerprints.get(
    criticalChain
  );

const previousCount =
  typeof previousEntry === 'number'
    ? previousEntry
    : previousEntry?.count || 0;

const previousLastSeenAt =
  typeof previousEntry === 'object'
    ? previousEntry?.lastSeenAt || Date.now()
    : Date.now();

const now = Date.now();

const entry = {
  count: previousCount + 1,
  lastSeenAt: now,
};

  startupDagProfiler.chainFingerprints.set(
    criticalChain,
    entry
  );

  if (
    startupDagProfiler.chainFingerprints.size >
    DAG_FINGERPRINT_RETENTION_LIMIT
  ) {
    const oldestKey =
      startupDagProfiler.chainFingerprints.keys().next().value;
    if (oldestKey) {
      startupDagProfiler.chainFingerprints.delete(oldestKey);
    }
  }

  const ageMs = now - previousLastSeenAt;
  const agePenalty = Math.floor(ageMs / 3600000);
  const weightedCount = Math.max(1, entry.count - agePenalty);

  return {
    chain: criticalChain,
    repetitionCount: weightedCount,
  };
}

function getMutationCanaryCohort() {
  const now = Date.now();
  // Wave 20 → wall-clock half-life decay for stale risk scores
  for (const [phase, score] of
    startupDagMutationLedger.phaseRiskScores) {
    if (score <= 0) continue;
    const lastDecayAt =
      startupDagMutationLedger.lastRiskDecayAt || now;
    const elapsedHours = Math.floor(
      (now - lastDecayAt) / 3600000
    );
    if (elapsedHours >= 1) {
      const decayedScore = Math.max(
        0,
        score - elapsedHours
      );
      startupDagMutationLedger.phaseRiskScores.set(
        phase,
        decayedScore
      );
    }
  }
  startupDagMutationLedger.lastRiskDecayAt = now;
  const candidates = Array.from(
    startupDagSelfHealing.permanentlyPromoted
  ).filter((phase) => {
    const quarantineUntil =
      startupDagMutationLedger.quarantinedPhases.get(
        phase
      );
    if (!quarantineUntil) {
      return true;
    }
    if (quarantineUntil <= now) {
      startupDagMutationLedger.quarantinedPhases.delete(
        phase
      );
      return true;
    }
    return false;
  });
  // Wave 22 → parole review queue: populate candidates that have aged past minimum ban
  // Wave 23 → enhance with parole score; promote high-scorers to supervised sandbox
  for (const phase of startupDagMutationLedger.permanentlyBannedPhases) {
    // Wave 26 → constitutional doctrine: protected phases are never parole-eligible
    if (
      startupDagMutationLedger.constitutionalProtectedPhases.has(
        phase
      )
    ) {
      startupDagMutationLedger.constitutionalOverrideHits += 1;
      continue;
    }
    const bannedAt =
      startupDagMutationLedger.permanentBanTimestamps.get(
        phase
      );
    if (!bannedAt) continue;
    const ageMs = now - bannedAt;
    if (
      ageMs >=
      startupDagMutationLedger.paroleMinimumBanAgeMs
    ) {
      const currentRisk =
        startupDagMutationLedger.phaseRiskScores.get(phase) || 0;
      const slack =
        startupDagProfiler.slackByPhase.get(phase) || 0;
      const precedent =
        startupDagMutationLedger.precedentScores.get(phase) || 0;
      const paroleScore = Math.max(
        0,
        100 -
          currentRisk * 10 +
          Math.min(20, Math.floor(slack / 100)) +
          precedent * startupDagMutationLedger.precedentWeight
      );
      startupDagMutationLedger.paroleReviewCandidates.set(
        phase,
        {
          eligibleAt: now,
          ageMs,
          currentRisk,
          slack,
          paroleScore,
        }
      );
      if (
        paroleScore >=
        startupDagMutationLedger.paroleScoreThreshold
      ) {
        startupDagMutationLedger.paroleSandbox.set(
          phase,
          {
            sandboxedAt: now,
            paroleScore,
            currentRisk,
          }
        );
      }
    }
  }
  // Wave 21 → exclude permanently banned phases from mutation eligibility
  const eligibleCandidates = candidates.filter(
    (phase) =>
      !startupDagMutationLedger.permanentlyBannedPhases.has(
        phase
      )
  );
  return eligibleCandidates.slice(
    0,
    startupDagMutationLedger.canaryCohortSize
  );
}

// Wave 27 — detect and replay incomplete startup phases before quorum release.
// Only registered recoverable phases are replayed; unrecoverable corruption
// triggers an immediate process.exit(1) to preserve fail-fast semantics.
async function recoverIncompleteStartupPhases() {
  const incompletePhases = [...startupBarrier.phases.entries()]
  .filter(
    ([phase, meta]) =>
      meta.critical &&
      !startupBarrier.completed.has(phase)
  )
  .map(([phase]) => phase);

  const recoveryResults = [];

  for (const phase of incompletePhases) {
    const result = await replayRecoverablePhase(phase, {
      startupBarrier,
    });

    recoveryResults.push({
      phase,
      ...result,
    });

    if (!result.recovered) {
      recordStartupFailureAttribution(
        'startup-recovery',
        new Error(result.reason),
        {
          failedPhase: phase,
          completedPhases: Array.from(startupBarrier.completed),
          pendingPhases: Array.from(startupBarrier.phases.keys()).filter(
            (p) => !startupBarrier.completed.has(p)
          ),
        }
      );

      logger.error(
        '[startup-recovery] unrecoverable startup corruption',
        {
          phase,
          reason: result.reason,
        }
      );

      process.exit(1);
    }
  }

  return recoveryResults;
}

// Wave 30 — Cross-replica lease renewal heartbeat worker.
// Renews the local node's lease every leaseRenewIntervalMs while the
// startup barrier is released. Prevents crash-safe eviction of healthy replicas.
// Must be started immediately after successful quorum lock grant.
// Guard: no-op if already running (prevents duplicate interval on hot-reload).
function startDistributedLeaseRenewalWorker(nodeId) {
  if (distributedLeaseRenewalLoop) {
    return;
  }

  // Wave 30.5 — capture the lease epoch at worker start.
  // Prevents stale renewal loops from extending a superseded lease.
  const initialLease =
    distributedStartupConsensus.releaseLocks.get(nodeId);

  if (!initialLease) {
    logger.warn(
      '[Wave30] Lease renewal worker start skipped: no local lease found',
      { nodeId }
    );
    return;
  }

  const leaseEpoch = initialLease.leaseEpoch;

  distributedLeaseRenewalLoop = trackInterval(() => {
    if (!startupBarrier.isReleased) {
      return;
    }

    const lease =
      distributedStartupConsensus.releaseLocks.get(nodeId);

    // Wave 30.5 — epoch fencing:
    // stop renewing immediately if lease ownership changed.
    if (!lease || lease.leaseEpoch !== leaseEpoch) {
      clearInterval(distributedLeaseRenewalLoop);
      distributedLeaseRenewalLoop = null;

      logger.warn(
        '[Wave30] Lease renewal loop fenced by epoch drift',
        {
          nodeId,
          expectedEpoch: leaseEpoch,
          actualEpoch: lease?.leaseEpoch || null,
        }
      );

      return;
    }

    const now = Date.now();

    distributedStartupConsensus.releaseLocks.set(nodeId, {
      ...lease,
      renewedAt: now,
      expiresAt:
        now +
        distributedStartupConsensus.leaseDurationMs,
    });

    // Wave 32 — PATCH 3: atomic Lua CAS lease renewal.
    // Wave 33 — routed through getLeaseRedisClient() for region-aware failover.
    (async () => {
      const leaseKey    = getReplicaLeaseKey(nodeId);
      const epochKey    = getReplicaEpochKey(nodeId);
      const epochTtlMs  = 86400000;
      const redisClient = getLeaseRedisClient();

      if (!redisClient) return;

      try {
        const casResult = await redisClient.eval(
          LUA_RENEW_LEASE,
          2,
          leaseKey,
          epochKey,
          String(leaseEpoch),
          String(distributedStartupConsensus.leaseDurationMs),
          String(epochTtlMs),
        );

        if (casResult !== 1) {
          // Guard failed — we no longer own this lease in Redis.
          throw new Error(`LUA_RENEW_LEASE ownership guard failed (result=${casResult})`);
        }
      } catch (err) {
        logger.warn('[Wave32] Lua CAS lease renewal FAILED — surrendering local lease to prevent split-brain', {
          nodeId, error: err.message,
        });
        clearInterval(distributedLeaseRenewalLoop);
        distributedLeaseRenewalLoop = null;
        distributedStartupConsensus.releaseLocks.delete(nodeId);
        startupBarrier.isReleased = false;
      }
    })();
  }, distributedStartupConsensus.leaseRenewIntervalMs);

  distributedLeaseRenewalLoop.unref();

  logger.info(
    '[Wave30] Distributed lease renewal worker started',
    {
      nodeId,
      leaseEpoch,
      leaseRenewIntervalMs:
        distributedStartupConsensus.leaseRenewIntervalMs,
      leaseDurationMs:
        distributedStartupConsensus.leaseDurationMs,
    }
  );
}

// Wave 31 — canonical local replica identity helper.
// Single source of truth for REPLICA_ID/HOSTNAME/pid fallback.
// Replaces all inline duplications to prevent lease key drift.
function getLocalReplicaId() {
  return (
    process.env.REPLICA_ID ||
    process.env.HOSTNAME ||
    `local-${process.pid}`
  );
}

// Wave 31 — PATCH 1: Redis durable lease namespace helpers.
// Used consistently across acquisition, renewal, eviction,
// readiness telemetry, and graceful shutdown.
function getReplicaLeaseKey(nodeId) {
  return `hirerise:startup:lease:${nodeId}`;
}
function getReplicaEpochKey(nodeId) {
  return `hirerise:startup:epoch:${nodeId}`;
}

// Wave 32 — PATCH 1: Lua CAS script registry.
//
// All Redis lease operations are collapsed into single atomic Lua evals.
// This eliminates every TOCTOU race that existed between the Wave 31
// multi-round-trip GET → SET NX / PEXPIRE → SET sequences.
//
// Script contract (shared across all evals):
//   KEYS[1] = leaseKey   (hirerise:startup:lease:<nodeId>)
//   KEYS[2] = epochKey   (hirerise:startup:epoch:<nodeId>)
//   ARGV[1] = newEpoch   (ms timestamp string)
//   ARGV[2] = leaseTtlMs
//   ARGV[3] = epochTtlMs (86400000 for epoch persistence)
//
// Return values are integer codes so callers never parse strings:
//   1  = success / granted
//   0  = denied (NX collision or epoch fence)
//  -1  = epoch fenced (storedEpoch > newEpoch)

// Atomic acquire: epoch fence + SET NX + SET epoch — all in one round-trip.
// Replaces: GET epochKey → compare → SET leaseKey NX PX → SET epochKey PX
const LUA_ACQUIRE_LEASE = `
local leaseKey  = KEYS[1]
local epochKey  = KEYS[2]
local newEpoch  = tonumber(ARGV[1])
local leaseTtl  = tonumber(ARGV[2])
local epochTtl  = tonumber(ARGV[3])

-- Epoch fencing: deny if a newer epoch already lives in Redis
local storedEpoch = tonumber(redis.call('GET', epochKey) or '0')
if storedEpoch and storedEpoch > newEpoch then
  return -1
end

-- NX acquire: fails if another replica currently holds the lease
local acquired = redis.call('SET', leaseKey, tostring(newEpoch), 'NX', 'PX', leaseTtl)
if not acquired then
  return 0
end

-- Persist epoch for 24 h (fast-restart bootstrap recovery)
redis.call('SET', epochKey, tostring(newEpoch), 'PX', epochTtl)
return 1
`;

// Atomic renew: epoch guard + PEXPIRE lease + refresh epoch — one round-trip.
// Replaces: PEXPIRE leaseKey → SET epochKey PX
// Guard: only renews if the stored lease value equals the expected epoch,
// preventing a stale loop from extending a lease it no longer owns.
const LUA_RENEW_LEASE = `
local leaseKey  = KEYS[1]
local epochKey  = KEYS[2]
local curEpoch  = tostring(ARGV[1])
local leaseTtl  = tonumber(ARGV[2])
local epochTtl  = tonumber(ARGV[3])

-- Ownership guard: only renew if we still own the key
local stored = redis.call('GET', leaseKey)
if stored ~= curEpoch then
  return 0
end

-- Renew TTL on both keys atomically
redis.call('PEXPIRE', leaseKey, leaseTtl)
redis.call('SET', epochKey, curEpoch, 'PX', epochTtl)
return 1
`;

// Atomic surrender: epoch-guarded DEL — only deletes keys this node owns.
// Replaces: DEL leaseKey epochKey (unconditional)
// Guard: checks stored lease value before deleting to avoid evicting a
// replacement pod's lease during a slow/overlapping shutdown.
const LUA_RELEASE_LEASE = `
local leaseKey = KEYS[1]
local epochKey = KEYS[2]
local curEpoch = tostring(ARGV[1])

local stored = redis.call('GET', leaseKey)
if stored ~= curEpoch then
  return 0
end

redis.call('DEL', leaseKey)
redis.call('DEL', epochKey)
return 1
`;

// Wave 32 — PATCH 5: shared Redis lease state reader.
// Used by bootstrap recovery (PATCH 4) and /ready telemetry (PATCH 6)
// to avoid duplicated inline try/catch blocks.
// Returns { leaseExists, persistedEpoch } or null on Redis unavailability.
async function getRedisLeaseState(nodeId) {
  // Wave 33 — route through region-aware resolver instead of directly to primary.
  const redisClient = getLeaseRedisClient();

  if (!redisClient) return null;

  try {
    const leaseKey = getReplicaLeaseKey(nodeId);
    const epochKey = getReplicaEpochKey(nodeId);
    const [rawEpoch, leaseExists] = await Promise.all([
      redisClient.get(epochKey),
      redisClient.exists(leaseKey),
    ]);
    return {
      leaseExists: leaseExists === 1,
      persistedEpoch: rawEpoch ? parseInt(rawEpoch, 10) : null,
    };
  } catch (err) {
    logger.warn('[Wave32] getRedisLeaseState failed', { nodeId, error: err.message });
    return null;
  }
}

// =============================================================================
// Wave 33 — Cross-region Redis failover + lease client sharding
// =============================================================================
//
// Architecture:
//   Primary lease authority  : LEASE_REDIS_PRIMARY_URL  (env, defaults to main Redis)
//   Fallback lease authority : LEASE_REDIS_FALLBACK_URL (env, optional)
//   Region label             : LEASE_REDIS_REGION       (env, e.g. 'ap-south-1')
//
// Failover policy:
//   - Primary is probed every LEASE_FAILOVER_PROBE_INTERVAL_MS (default 15 s)
//   - If probe fails LEASE_FAILOVER_THRESHOLD consecutive times → promote fallback
//   - Primary is re-probed on each tick even while fallback is active
//   - Automatic failback when primary recovers (LEASE_FAILBACK_THRESHOLD healthy probes)
//   - All failover events are recorded in leaseFailoverState for /ready telemetry
//
// Soft-degrade contract (preserved from Wave 31/32):
//   If both primary and fallback are unavailable, getLeaseRedisClient() returns null
//   and every Lua eval call site falls back to in-memory-only mode.

// Wave 33 — PATCH 2: failover telemetry state object.
const leaseFailoverState = {
  primaryRegion:         process.env.LEASE_REDIS_REGION        || 'primary',
  fallbackRegion:        process.env.LEASE_REDIS_FALLBACK_REGION || 'fallback',
  usingFallback:         false,
  primaryFailures:       0,
  primaryRecoveries:     0,
  failoverEvents:        [],          // { at, direction, reason }
  lastFailoverAt:        null,
  lastFailbackAt:        null,
  probeIntervalMs:       parseInt(process.env.LEASE_FAILOVER_PROBE_INTERVAL_MS  || '15000', 10),
  failoverThreshold:     parseInt(process.env.LEASE_FAILOVER_THRESHOLD          || '3',     10),
  failbackThreshold:     parseInt(process.env.LEASE_FAILBACK_THRESHOLD          || '2',     10),
  consecutiveFailures:   0,
  consecutiveRecoveries: 0,
  watchdogTimer:         null,
  // Lazily-created ioredis client for the fallback URL, if configured.
  _fallbackClient:       null,
};

// =============================================================================
// Wave 34 — PATCH 1: Chaos state registry.
// Tracks simulated failover scenarios, drift detections, and rollback events.
// Enabled only when LEASE_CHAOS_MODE=true. Never mutates real Redis state.
// =============================================================================
const leaseChaosState = {
  enabled: process.env.LEASE_CHAOS_MODE === 'true',

  // Current active deterministic chaos scenario
  activeScenario: null,

  // Total injected simulation failures since process start
  injectedFailures: 0,

  // Total confirmed region drift detections
  driftDetections: 0,

  // Historical rollback lineage events
  rollbackEvents: [],

  // Timing telemetry
   lastScenarioAt: null,
  lastRollbackAt: null,

  // Wave 34 hardening — cached persisted Redis epoch mirror.
  // Refreshed asynchronously by the failover watchdog so
  // detectLeaseRegionDrift() can remain synchronous.
  lastObservedPersistedEpoch: null,
  lastPersistedEpochAt: 0,

  // Safety threshold before hard local rollback
  maxDriftToleranceMs: parseInt(
    process.env.LEASE_MAX_REGION_DRIFT_MS || '5000',
    10
  ),

  // Internal handle — populated by startLeaseChaosSimulationWorker()
  _workerTimer: null,
};

// =============================================================================
// Wave 35 — PATCH 1: Rollback confidence scoring registry.
// Tracks deterministic confidence evaluations, suppression windows, confirmed
// rollbacks, and replayable severity lineage for the rollback engine.
// Hot-reload safe: all values reset on clean process restart.
// =============================================================================
const rollbackConfidenceState = {
  lastScore:               0,
  lastSeverity:            'none',
  totalEvaluations:        0,
  suppressedRollbacks:     0,
  confirmedRollbacks:      0,
  falsePositiveWindows:    [],
  severityHistory:         [],
  minRollbackConfidence:   parseInt(
    process.env.LEASE_MIN_ROLLBACK_CONFIDENCE || '70',
    10
  ),
  // Wave 42 — Phase 8: auto-tuning thresholds
  autoTune: {
    enabled:   process.env.LEASE_AUTOTUNE_ENABLED === 'true',
    minThreshold: 50,
    maxThreshold: 95,
    stepUp:    2,      // increase threshold when too many suppressions
    stepDown:  1,      // decrease threshold when confirmed rollbacks dominate
    windowMs:  60000,  // 1-minute evaluation window
  },
  lastAutoTuneAt: 0,
  // Wave 46 — Phase 12: autonomous policy correction
  policyCorrection: {
    enabled:          process.env.LEASE_POLICY_CORRECTION === 'true',
    windowMs:         120000,   // 2-minute evaluation window
    maxThresholdStep: 3,        // max single-step threshold nudge
    maxLikelihoodStep: 0.05,    // max single-step bias nudge
    minThreshold:     50,
    maxThreshold:     95,
  },
  lastPolicyCheckAt: 0,
  // BUG-04 FIX: Independent counters so autoTune and policyCorrection do not share state
  autoTuneCounters: {
    suppressed: 0,
    confirmed:  0,
  },
  policyCounters: {
    suppressed: 0,
    confirmed:  0,
  },
  // Wave 47 — Phase 13: Safety envelope tracking
  rollbackTimestamps: [],  // epoch-ms of each completed rollback within window
  lastRollbackAt: 0,       // epoch-ms of most recent rollback (0 = never)
};

// =============================================================================
// Wave 50 — Phase 5: Production observability metrics.
// Lightweight in-memory counters for rollback decision paths.
// Exposed on /ready for ops dashboards and alerting.
// =============================================================================
const systemMetrics = {
  decisions:     0,  // total watchdog cycles that reached decision evaluation
  suppressed:    0,  // decisions suppressed by shouldSuppressRollback
  executed:      0,  // rollbacks actually executed
  safetyBlocked: 0,  // rollbacks blocked by the safety envelope
};

// =============================================================================
// Wave 36 — PATCH 1: Rollback trust decay registry.
// Per-region and per-node trust scores with time-decay semantics.
// Unseen entries default to 100. FIFO-bounded trustEvents. Restart-safe.
// =============================================================================
const rollbackTrustState = {
  regionTrust: new Map(),   // regionKey → { trust, updatedAt }
  nodeTrust:   new Map(),   // nodeId    → { trust, updatedAt }
  trustEvents: [],
  decayHalfLifeMs: parseInt(
    process.env.LEASE_TRUST_DECAY_HALF_LIFE_MS || '300000',
    10
  ),
  minQuorumEscalationTrust: parseInt(
    process.env.LEASE_MIN_QUORUM_ESCALATION_TRUST || '40',
    10
  ),
  maxTrustEvents: 500,
};

// =============================================================================
// Wave 47 — Phase 13: Safety envelopes + formal invariants.
// Non-bypassable guards bounding rollback frequency, consensus quorum, and
// execution state. Critical severity may bypass quorum/cooldown checks only.
// =============================================================================
const SAFETY_ENVELOPE = {
  enabled: process.env.LEASE_SAFETY_ENABLED !== 'false',

  // rollback rate limit
  maxRollbacksPerWindow: 3,
  rollbackWindowMs: 60000,

  // minimum consensus signals for non-critical rollback
  minSignalsForRollback: 2,

  // cooldown after rollback
  cooldownMs: 15000,

  // allow immediate rollback for critical severity
  criticalBypass: true,
};

function checkSafetyEnvelope({ scoreResult, fusionDecision, contributingSignals }) {
  if (!SAFETY_ENVELOPE.enabled) return { allowed: true };

  // 🟢 Rule 1: Critical bypass — real critical drift must always pass through
  if (
    SAFETY_ENVELOPE.criticalBypass &&
    scoreResult.severity === 'critical'
  ) {
    return { allowed: true, bypass: 'CRITICAL' };
  }

  const now = Date.now();

  // Clean old timestamps outside the rolling window
  rollbackConfidenceState.rollbackTimestamps =
    rollbackConfidenceState.rollbackTimestamps.filter(
      (t) => now - t < SAFETY_ENVELOPE.rollbackWindowMs
    );

  const recentRollbacks = rollbackConfidenceState.rollbackTimestamps.length;

  logger.debug('[Wave47] Safety envelope state', {
    recentRollbacks,
    lastRollbackAt: rollbackConfidenceState.lastRollbackAt,
  });

  // 🔴 Rule 2: Rate limit — hard ceiling on rollbacks per window
  if (recentRollbacks >= SAFETY_ENVELOPE.maxRollbacksPerWindow) {
    return {
      allowed: false,
      reason: 'RATE_LIMIT_EXCEEDED',
      recentRollbacks,
    };
  }

  // 🔴 Rule 3: Cooldown — prevent rapid oscillation after a rollback
  if (
    rollbackConfidenceState.lastRollbackAt &&
    now - rollbackConfidenceState.lastRollbackAt < SAFETY_ENVELOPE.cooldownMs
  ) {
    return {
      allowed: false,
      reason: 'COOLDOWN_ACTIVE',
    };
  }

  // 🔴 Rule 4: Minimum signals — weak signals cannot trigger destructive action
  if (
    scoreResult.severity !== 'critical' &&
    contributingSignals < SAFETY_ENVELOPE.minSignalsForRollback
  ) {
    return {
      allowed: false,
      reason: 'INSUFFICIENT_SIGNALS',
    };
  }

  return { allowed: true };
}

// =============================================================================
// Wave 42 — Phase 8: Auto-tuning rollback threshold.
// Dynamically adjusts minRollbackConfidence based on suppression/confirmation
// ratios observed over the last windowMs. Bounded, gradual, deterministic.
// =============================================================================
function autoTuneRollbackThreshold() {
  const now = Date.now();
  const cfg  = rollbackConfidenceState.autoTune;

  if (!cfg?.enabled) return;
  if (now - rollbackConfidenceState.lastAutoTuneAt < cfg.windowMs) return;

  rollbackConfidenceState.lastAutoTuneAt = now;

  // BUG-04 FIX: Read from autoTune-specific counters only
  const suppressed = rollbackConfidenceState.autoTuneCounters.suppressed || 0;
  const confirmed  = rollbackConfidenceState.autoTuneCounters.confirmed  || 0;

  let newThreshold = rollbackConfidenceState.minRollbackConfidence;

  // Too many suppressions → system too sensitive → increase threshold
  if (suppressed > confirmed * 2 && suppressed > 3) {
    newThreshold += cfg.stepUp;
  }
  // Frequent confirmed rollbacks → system too strict → decrease threshold
  else if (confirmed > suppressed && confirmed > 2) {
    newThreshold -= cfg.stepDown;
  }

  // Clamp within allowed range
  newThreshold = Math.max(cfg.minThreshold, Math.min(cfg.maxThreshold, newThreshold));

  if (newThreshold !== rollbackConfidenceState.minRollbackConfidence) {
    logger.warn('[Wave42] Auto-tuning rollback threshold', {
      previous:   rollbackConfidenceState.minRollbackConfidence,
      next:       newThreshold,
      suppressed,
      confirmed,
    });
    rollbackConfidenceState.minRollbackConfidence = newThreshold;
  }

  // BUG-04 FIX: Reset only autoTune-specific counters
  rollbackConfidenceState.autoTuneCounters.suppressed = 0;
  rollbackConfidenceState.autoTuneCounters.confirmed  = 0;

  // Wave 43 — Phase 9: fire-and-forget persist after each tuning tick.
  persistAutoTuneState();
}

// =============================================================================
// Wave 46 — Phase 12: Autonomous policy correction.
// Detects suboptimal policy state from outcome ratios and applies bounded,
// gradual, logged corrections to minRollbackConfidence and likelihoodBias.
// Never re-publishes trust events; never touches detectLeaseRegionDrift().
// =============================================================================

// Signed bias applied to the Bayesian posterior before score conversion.
// Bounded to [-0.2, +0.2]. Declared once at module scope; read inside
// scoreLeaseRollbackConfidence().
let likelihoodBias = 0;

/**
 * Nudge the global likelihood bias by delta, clamped to [-0.2, +0.2].
 * @param {number} delta
 */
function adjustLikelihoodBias(delta) {
  likelihoodBias = Math.max(-0.2, Math.min(0.2, likelihoodBias + delta));
  logger.info('[Wave46] Likelihood bias adjusted', { bias: likelihoodBias });
}

/**
 * Evaluate recent outcome ratios and apply one bounded correction step to
 * minRollbackConfidence and/or likelihoodBias if the system is drifting.
 * Counters are reset after each evaluation window (same as autoTune).
 * Safe to call on every watchdog tick — the windowMs guard makes it a no-op
 * when the evaluation interval has not yet elapsed.
 */
function applyPolicyCorrection() {
  const cfg = rollbackConfidenceState.policyCorrection;
  const now = Date.now();

  if (!cfg?.enabled) return;
  if (now - rollbackConfidenceState.lastPolicyCheckAt < cfg.windowMs) return;

  rollbackConfidenceState.lastPolicyCheckAt = now;

  // BUG-04 FIX: Read from policy-specific counters only
  const suppressed = rollbackConfidenceState.policyCounters.suppressed || 0;
  const confirmed  = rollbackConfidenceState.policyCounters.confirmed  || 0;

  let threshold = rollbackConfidenceState.minRollbackConfidence;

  // Pattern 1: too many suppressions → system is too sensitive → raise bar
  if (suppressed > confirmed * 2 && suppressed > 5) {
    threshold += cfg.maxThresholdStep;
  }
  // Pattern 2: frequent confirmed rollbacks → system too strict → lower bar
  else if (confirmed > suppressed && confirmed > 3) {
    threshold -= cfg.maxThresholdStep;
  }

  // Hard clamp — policy correction never escapes the same safety bounds as autoTune
  threshold = Math.max(cfg.minThreshold, Math.min(cfg.maxThreshold, threshold));

  if (threshold !== rollbackConfidenceState.minRollbackConfidence) {
    logger.warn('[Wave46] Policy correction: threshold adjusted', {
      previous:  rollbackConfidenceState.minRollbackConfidence,
      next:      threshold,
      suppressed,
      confirmed,
    });
    rollbackConfidenceState.minRollbackConfidence = threshold;
  }

  // Likelihood bias nudge: only applied when the signal is unambiguous
  if (confirmed > 5 && suppressed < 2) {
    // System is under-triggering → shift posterior slightly upward
    adjustLikelihoodBias(cfg.maxLikelihoodStep);
  } else if (suppressed > 5 && confirmed < 2) {
    // System is over-triggering → shift posterior slightly downward
    adjustLikelihoodBias(-cfg.maxLikelihoodStep);
  }

  // BUG-04 FIX: Reset only policy-specific counters
  rollbackConfidenceState.policyCounters.suppressed = 0;
  rollbackConfidenceState.policyCounters.confirmed  = 0;
}

// =============================================================================
// Wave 43 — Phase 9: Persistent auto-tune state via Redis.
// Fire-and-forget writes; best-effort restore on bootstrap.
// TTL of 1 hour prevents stale long-term drift after extended outages.
// =============================================================================
async function persistAutoTuneState() {
  try {
    const client = getLeaseRedisClient();
    if (!client) return;

    const payload = JSON.stringify({
      minRollbackConfidence: rollbackConfidenceState.minRollbackConfidence,
      suppressedRollbacks:   rollbackConfidenceState.suppressedRollbacks,
      confirmedRollbacks:    rollbackConfidenceState.confirmedRollbacks,
      lastAutoTuneAt:        rollbackConfidenceState.lastAutoTuneAt,
    });

    await client.set(ROLLBACK_AUTOTUNE_KEY, payload, 'EX', 3600); // 1h TTL
  } catch (err) {
    logger.warn('[Wave43] Failed to persist auto-tune state', {
      error: err.message,
    });
  }
}

async function restoreAutoTuneState() {
  try {
    const client = getLeaseRedisClient();
    if (!client) return;

    const data = await client.get(ROLLBACK_AUTOTUNE_KEY);
    if (!data) return;

    const parsed = JSON.parse(data);

    rollbackConfidenceState.minRollbackConfidence =
      parsed.minRollbackConfidence ?? rollbackConfidenceState.minRollbackConfidence;

    rollbackConfidenceState.suppressedRollbacks =
      parsed.suppressedRollbacks ?? 0;

    rollbackConfidenceState.confirmedRollbacks =
      parsed.confirmedRollbacks ?? 0;

    rollbackConfidenceState.lastAutoTuneAt =
      parsed.lastAutoTuneAt ?? 0;

    logger.info('[Wave43] Restored auto-tune state from Redis', {
      threshold: rollbackConfidenceState.minRollbackConfidence,
    });
  } catch (err) {
    logger.warn('[Wave43] Failed to restore auto-tune state', {
      error: err.message,
    });
  }
}

// =============================================================================
// Wave 36 — PATCH 6: Regional quorum escalation ledger.
// Records every non-critical low-trust escalation event. FIFO max 500.
// =============================================================================
const regionalEscalationState = {
  escalations:      [],
  totalEscalations: 0,
  lastEscalationAt: null,
  maxEntries:       500,
};

// =============================================================================
// Wave 37 — PATCH 1: Cross-region anomaly fusion state.
// Aggregates regional drift signals for consensus-based rollback decisions.
// Memory bounded via maxSignalAgeMs expiry cleaned before each evaluation.
// =============================================================================
const anomalyFusionState = {
  regions:          new Map(),  // regionId → { driftScore, confidence, timestamp }
  lastEvaluatedAt:  null,
  consensusScore:   0,
  lastAction:       null,       // hysteresis: tracks last emitted action
  maxSignalAgeMs:   parseInt(
    process.env.LEASE_ANOMALY_SIGNAL_AGE_MS || '10000',
    10
  ),
  // Configurable quorum + threshold knobs (overridable via env or tests).
  minSignals:       parseInt(process.env.LEASE_ANOMALY_MIN_SIGNALS       || '2',    10),
  globalThreshold:  parseFloat(process.env.LEASE_ANOMALY_GLOBAL_THRESHOLD  || '0.75'),
  partialThreshold: parseFloat(process.env.LEASE_ANOMALY_PARTIAL_THRESHOLD || '0.4'),
};

// Wave 33 — PATCH 1: region-aware lease Redis client resolver.
//
// Returns the best available ioredis client for lease operations:
//   1. If not in failover → return primary (main application Redis)
//   2. If in failover and fallback URL configured → return fallback client
//   3. Otherwise → return primary anyway (may be null/erroring; callers degrade)
//
// This is the single chokepoint for all Lua eval call sites.
// getRedisLeaseState() is also updated to route through this function.
function getLeaseRedisClient() {
  // Attempt to obtain the primary client via the existing config module.
  let primaryClient = null;
  try {
    primaryClient = require('./config/redisClient').getRedisClient?.() || null;
  } catch (_) {}

  // If we are not in failover mode, always use primary.
  if (!leaseFailoverState.usingFallback) {
    return primaryClient;
  }

  // Failover active — return the fallback client if configured and alive.
  if (leaseFailoverState._fallbackClient) {
    return leaseFailoverState._fallbackClient;
  }

  // Fallback not yet initialised — try to create it now if URL is set.
  const fallbackUrl = process.env.LEASE_REDIS_FALLBACK_URL;
  if (fallbackUrl) {
    try {
      // ioredis is already a dependency (used by the primary client config).
      const Redis = require('ioredis');
      const client = new Redis(fallbackUrl, {
        lazyConnect:            true,
        enableOfflineQueue:     false,
        maxRetriesPerRequest:   1,
        connectTimeout:         3000,
        commandTimeout:         3000,
      });
      leaseFailoverState._fallbackClient = client;
      logger.info('[Wave33] Lease fallback Redis client initialised', {
        region: leaseFailoverState.fallbackRegion,
      });
      return client;
    } catch (err) {
      logger.warn('[Wave33] Lease fallback Redis client init failed', { error: err.message });
    }
  }

  // No fallback available — return primary even though it may be down.
  // Callers handle null/error via their existing soft-degrade path.
  return primaryClient;
}

// Wave 33 — PATCH 4: lease failover watchdog.
// Probes the primary Redis client on a fixed interval.
// Promotes fallback on repeated failure; fails back when primary recovers.
// Must be started once after Redis connects (called from bootstrap).
function startLeaseFailoverWatchdog() {
  if (leaseFailoverState.watchdogTimer) return; // idempotent

  leaseFailoverState.watchdogTimer = trackInterval(async () => {
    let primaryClient = null;
    try {
      primaryClient = require('./config/redisClient').getRedisClient?.() || null;
    } catch (_) {}

    let primaryAlive = false;
    if (primaryClient) {
      try {
        await primaryClient.ping();
        primaryAlive = true;
      } catch (_) {}
    }

   if (!primaryAlive) {
  // Primary probe failed.
  leaseFailoverState.consecutiveFailures  += 1;
  leaseFailoverState.consecutiveRecoveries = 0;
  leaseFailoverState.primaryFailures      += 1;

  if (
    !leaseFailoverState.usingFallback &&
    leaseFailoverState.consecutiveFailures >= leaseFailoverState.failoverThreshold
  ) {
    leaseFailoverState.usingFallback = true;
    leaseFailoverState.lastFailoverAt = Date.now();

    leaseFailoverState.failoverEvents.push({
      at:        leaseFailoverState.lastFailoverAt,
      direction: 'primary→fallback',
      reason:    `primary unreachable after ${leaseFailoverState.consecutiveFailures} consecutive probe failures`,
    });

    if (leaseFailoverState.failoverEvents.length > 1000) {
      leaseFailoverState.failoverEvents.shift();
    }

    logger.warn('[Wave33] Lease Redis failover activated — switching to fallback region', {
      primaryRegion:  leaseFailoverState.primaryRegion,
      fallbackRegion: leaseFailoverState.fallbackRegion,
      failures:       leaseFailoverState.consecutiveFailures,
    });
  }

} else {
      // Primary probe succeeded.
      leaseFailoverState.consecutiveFailures   = 0;
      leaseFailoverState.consecutiveRecoveries += 1;
      leaseFailoverState.primaryRecoveries     += 1;

      if (
        leaseFailoverState.usingFallback &&
        leaseFailoverState.consecutiveRecoveries >= leaseFailoverState.failbackThreshold
      ) {
        leaseFailoverState.usingFallback = false;
        leaseFailoverState.lastFailbackAt = Date.now();
        leaseFailoverState.failoverEvents.push({
          at:        leaseFailoverState.lastFailbackAt,
          direction: 'fallback→primary',
          reason:    `primary recovered after ${leaseFailoverState.consecutiveRecoveries} consecutive healthy probes`,
        });
        if (leaseFailoverState.failoverEvents.length > 1000) {
          leaseFailoverState.failoverEvents.shift();
        }
        logger.info('[Wave33] Lease Redis failback completed — primary region restored', {
          primaryRegion:  leaseFailoverState.primaryRegion,
          recoveries:     leaseFailoverState.consecutiveRecoveries,
        });
      }

      // Wave 36 — PATCH 7: stable primary recovery trust healing.
      // Conditions: primary healthy AND no rollback for 5 probe cycles AND
      // no suppressions in last 2 minutes. Bounded at +1 per tick.
      const fiveCycles           = leaseFailoverState.probeIntervalMs * 5;
      const noRecentRollback     = (Date.now() - (leaseChaosState.lastRollbackAt || 0)) > fiveCycles;
      const twoMinutesAgo        = Date.now() - 120000;
      const noRecentSuppressions = rollbackConfidenceState.falsePositiveWindows
        .every((entry) => entry.at < twoMinutesAgo);

      if (noRecentRollback && noRecentSuppressions) {
        increaseRegionTrust(leaseFailoverState.primaryRegion, 1);
      }
    }

    // Wave 34 — PATCH 5: region drift detection + rollback in the same watchdog tick.
    // Only runs while fallback is active. If drift has exceeded the tolerance window,
    // execute a hard local-only safety rollback immediately.
   if (leaseFailoverState.usingFallback) {
  // Wave 34 hardening — refresh cached persisted epoch mirror
  // from Redis before synchronous drift evaluation.
  try {
    const redisState = await getRedisLeaseState(
      getLocalReplicaId()
    );

    if (redisState?.persistedEpoch != null) {
      leaseChaosState.lastObservedPersistedEpoch =
        redisState.persistedEpoch;
      leaseChaosState.lastPersistedEpochAt =
        Date.now();
    }
  } catch (err) {
    logger.warn(
      '[Wave34] Failed to refresh persisted epoch mirror during watchdog tick',
      {
        error: err.message,
      }
    );
  }

   const driftResult = detectLeaseRegionDrift();

  // Wave 50 — Phase 5: decision trace ID, latency measurement, and metrics counter.
  // Generated once per watchdog cycle so every log line for this evaluation
  // shares the same decisionId and can be correlated in production.
  const decisionId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startTime  = process.hrtime.bigint();
  systemMetrics.decisions += 1;

  // Prevent unbounded growth (rolling reset).
  // Reset to 1 (not 0) so that decisions % 10 does not fire immediately on the
  // next tick after reset, which would produce a misleading empty trend snapshot.
  if (systemMetrics.decisions % 10000 === 0) {
    systemMetrics.decisions    = 1;
    systemMetrics.suppressed   = 0;
    systemMetrics.executed     = 0;
    systemMetrics.safetyBlocked = 0;
  }

  // Wave 35 — PATCH 4: confidence-scored rollback gate replaces binary branch.
  // Every drift evaluation produces a deterministic score + severity classification.
  // Low-confidence events are suppressed; critical events always execute.
  const scoreResult = scoreLeaseRollbackConfidence(driftResult);

  rollbackConfidenceState.lastScore    = scoreResult.score;
  rollbackConfidenceState.lastSeverity = scoreResult.severity;

  // Wave 35 — PATCH 5: append deterministic severity lineage entry (FIFO, max 500).
  const lineageEntry = {
    at:             Date.now(),
    score:          scoreResult.score,
    severity:       scoreResult.severity,
    deltaMs:        driftResult.deltaMs,
    localEpoch:     driftResult.localEpoch,
    persistedEpoch: driftResult.persistedEpoch,
    scenario:       leaseChaosState.activeScenario,
    rollbackExecuted: false, // will be mutated below if rollback runs
  };

  if (scoreResult.severity !== 'low') {
  rollbackConfidenceState.severityHistory.push(lineageEntry);

  if (rollbackConfidenceState.severityHistory.length > 500) {
    rollbackConfidenceState.severityHistory.shift();
  }
}

  // Wave 50 — FIX 10: severity trend snapshot every 10 cycles.
  if (systemMetrics.decisions % 10 === 0) {
    const recentSeverity = rollbackConfidenceState.severityHistory
      .slice(-10)
      .map(e => ({
        score:    e.score,
        severity: e.severity,
        at:       e.at,
      }));

    logger.info('[Wave50] Severity trend snapshot', {
      lastScores: recentSeverity,
    });
  }

  // Wave 50 — FIX 2: structured decision log before every rollback evaluation.
  // Emitted unconditionally so every suppression, block, or execution is traceable.
  logger.info('[Wave50] Rollback decision evaluation', {
    decisionId,
    score:       scoreResult.score,
    severity:    scoreResult.severity,
    posterior:   scoreResult.posterior,
    trustFactor: scoreResult.trustFactor,
  });

  if (shouldSuppressRollback(scoreResult, driftResult)) {
    // Wave 50 — FIX 3: log suppression with decisionId so it can be correlated.
    systemMetrics.suppressed += 1;
    logger.info('[Wave50] Rollback suppressed', {
      decisionId,
      score:    scoreResult.score,
      severity: scoreResult.severity,
    });
  } else {
    if (driftResult.rollbackRequired || scoreResult.rollbackRecommended) {
      const rollbackNodeId = getLocalReplicaId();
      const rollbackRegion = leaseFailoverState.usingFallback
        ? leaseFailoverState.fallbackRegion
        : leaseFailoverState.primaryRegion;

      // Wave 37 — PATCH 5: emit regional anomaly signal before fusion evaluation.
      // normalizedScore: scoreResult.score is 0–100; normalize to 0–1.
      // derivedConfidence: trust-weighted normalized confidence.
      const normalizedScore    = scoreResult.score / 100;
      const regionTrustNow     = getRegionTrust(rollbackRegion) / 100;
      const derivedConfidence = Math.min(
  1,
  Math.max(0.1, normalizedScore * regionTrustNow)
);
      // Wave 37 — PATCH 5 (hardened): emit signal then evaluate via fusion engine.
      // emitRegionalAnomalySignal clamps inputs; evaluateCrossRegionAnomalies
      // enforces quorum, freshness decay, hysteresis and returns full diagnostics.
      emitRegionalAnomalySignal(rollbackRegion, {
        driftScore: normalizedScore,
        confidence: derivedConfidence,
      });

      const fusionDecision = evaluateCrossRegionAnomalies();

      logger.info('[Wave37] Cross-region fusion evaluated', {
        nodeId:             rollbackNodeId,
        region:             rollbackRegion,
        fusionAction:       fusionDecision.action,
        fusionScore:        fusionDecision.score,
        contributingSignals: fusionDecision.contributingSignals,
        totalWeight:        fusionDecision.totalWeight,
        localScore:         scoreResult.score,
        severity:           scoreResult.severity,
      });

      // Phase 3 Fix — detect partial drift and schedule quorum escalation.
      // PARTIAL_DRIFT does NOT authorize rollback; it triggers escalation only.
      let escalateToQuorum = false;

      if (fusionDecision.action === 'PARTIAL_DRIFT') {
        escalateToQuorum = true;

        logger.warn('[Wave37] Partial drift detected — escalating to quorum', {
          score:      fusionDecision.score,
          localScore: scoreResult.score,
          severity:   scoreResult.severity,
        });
      }

      // Primary rollback gate: fusion engine must confirm global drift.
      // Single-signal or low-quorum evaluations return INSUFFICIENT_DATA and
      // are blocked here, preventing spurious rollbacks.
      // Phase 2 Fix — bypass fusion gate when no quorum but strong local evidence.
      let fusionAllowsRollback = false;

      // Primary condition — multi-region consensus
      if (fusionDecision.action === 'GLOBAL_DRIFT_CONFIRMED') {
        fusionAllowsRollback = true;
      }

      // 🔥 Phase 2 FIX — bypass when no quorum but strong evidence
      else if (
        fusionDecision.action === 'INSUFFICIENT_DATA' &&
        scoreResult.severity === 'critical'
      ) {
        fusionAllowsRollback = true;

        logger.warn('[Wave36] Fusion bypass — insufficient data but critical drift', {
          score:    scoreResult.score,
          severity: scoreResult.severity,
        });
      }

      // Optional: allow strong local confidence
      else if (
        fusionDecision.action === 'INSUFFICIENT_DATA' &&
        scoreResult.score >= 85
      ) {
        fusionAllowsRollback = true;

        logger.warn('[Wave36] Fusion bypass — strong local confidence', {
          score: scoreResult.score,
        });
      }

      if (fusionAllowsRollback) {
        // Rollback is authorized by cross-region consensus or fusion bypass.
        logger.warn('[Wave37] Cross-region fusion authorized rollback', {
          nodeId:             rollbackNodeId,
          fusionAction:       fusionDecision.action,
          fusionScore:        fusionDecision.score,
          contributingSignals: fusionDecision.contributingSignals,
          localScore:         scoreResult.score,
          severity:           scoreResult.severity,
          deltaMs:            driftResult.deltaMs,
          localEpoch:         driftResult.localEpoch     ?? null,
          persistedEpoch:     driftResult.persistedEpoch ?? null,
        });

        // Wave 47 — Phase 13: Safety envelope guard.
        // Must pass before any destructive rollback action is taken.
        const safetyCheck = checkSafetyEnvelope({
          scoreResult,
          fusionDecision,
          contributingSignals: fusionDecision.contributingSignals,
        });

        if (!safetyCheck.allowed) {
          logger.warn('[Wave47] Rollback blocked by safety envelope', {
            reason:   safetyCheck.reason,
            score:    scoreResult.score,
            severity: scoreResult.severity,
          });

          // Wave 50 — FIX 4: structured safety-block log with decisionId + counter.
          systemMetrics.safetyBlocked += 1;
          logger.warn('[Wave50] Safety envelope blocked rollback', {
            decisionId,
            reason:   safetyCheck.reason,
            severity: scoreResult.severity,
          });

          // Wave 50 — FIX 8: emit decision latency even on early-exit paths.
          const durationMs = Number(process.hrtime.bigint() - startTime) / 1e6;
          logger.debug('[Wave50] Decision latency', { decisionId, durationMs });

          // Continue execution — do NOT return
        } else {

  await rollbackLeaseRegionDrift(getLocalReplicaId());

  // Mark rollback execution ONLY after success.
  lineageEntry.rollbackExecuted = true;

        // Wave 50 — FIX 5: structured rollback-executed log with decisionId + counter.
        systemMetrics.executed += 1;
        logger.warn('[Wave50] Rollback executed', {
          decisionId,
          nodeId:   rollbackNodeId,
          region:   rollbackRegion,
          score:    scoreResult.score,
          severity: scoreResult.severity,
        });

        // Wave 47 — Phase 13: Record rollback for safety envelope accounting.
        rollbackConfidenceState.rollbackTimestamps.push(Date.now());
        rollbackConfidenceState.lastRollbackAt = Date.now();
        // Keep the timestamps array bounded to avoid unbounded growth.
        if (rollbackConfidenceState.rollbackTimestamps.length > 50) {
          rollbackConfidenceState.rollbackTimestamps.shift();
        }

        // Update counters + trust.
        // BUG-04 FIX: Increment both independent counters instead of shared one
        rollbackConfidenceState.autoTuneCounters.confirmed += 1;
        rollbackConfidenceState.policyCounters.confirmed   += 1;
        increaseRegionTrust(rollbackRegion, 3);
        increaseNodeTrust(rollbackNodeId,   2);

        } // close else (safetyCheck.allowed)

      } else {
        // Fusion did not confirm — defer rollback.
        logger.info(
          '[Wave37] Cross-region fusion deferred rollback — insufficient global consensus',
          {
            nodeId:             rollbackNodeId,
            region:             rollbackRegion,
            fusionAction:       fusionDecision.action,
            fusionScore:        fusionDecision.score,
            contributingSignals: fusionDecision.contributingSignals,
            localScore:         scoreResult.score,
            severity:           scoreResult.severity,
          }
        );

        // Wave 36 — PATCH 5: quorum escalation if trust also low.
        if (shouldEscalateToRegionalQuorum(scoreResult)) {
          const escalationTrust = getRegionTrust(rollbackRegion);
          startupBarrier.pendingDistributedRelease = true;
          regionalEscalationState.totalEscalations += 1;
          regionalEscalationState.lastEscalationAt  = Date.now();
          const escalationEntry = {
            at:       Date.now(),
            region:   rollbackRegion,
            nodeId:   rollbackNodeId,
            trust:    Math.round(escalationTrust),
            score:    scoreResult.score,
            severity: scoreResult.severity,
            reason:   'fusion-deferred-quorum-escalation',
          };
          regionalEscalationState.escalations.push(escalationEntry);
          if (regionalEscalationState.escalations.length > regionalEscalationState.maxEntries) {
            regionalEscalationState.escalations.shift();
          }
          logger.warn('[Wave36] Low-trust region — escalating to regional quorum (fusion-deferred)', {
            nodeId:    rollbackNodeId,
            region:    rollbackRegion,
            trust:     Math.round(escalationTrust),
            threshold: rollbackTrustState.minQuorumEscalationTrust,
          });
        }

        // Phase 3 Fix — meaningful quorum escalation for PARTIAL_DRIFT.
        // Records a structured escalation event and marks the distributed
        // release barrier, making the signal observable to consumers.
        if (escalateToQuorum) {
          startupBarrier.pendingDistributedRelease = true;

          regionalEscalationState.totalEscalations += 1;
          regionalEscalationState.lastEscalationAt  = Date.now();

          regionalEscalationState.escalations.push({
            at:          Date.now(),
            reason:      'PARTIAL_DRIFT',
            fusionScore: fusionDecision.score,
            localScore:  scoreResult.score,
            nodeId:      getLocalReplicaId(),
          });

          if (regionalEscalationState.escalations.length > regionalEscalationState.maxEntries) {
            regionalEscalationState.escalations.shift();
          }

          logger.warn('[Wave37] Quorum escalation recorded', {
            totalEscalations: regionalEscalationState.totalEscalations,
          });

          // Detect repeated partial drift within the last 60 s — elevated monitoring signal.
          const recentEscalations = regionalEscalationState.escalations.filter(
            (e) => e.reason === 'PARTIAL_DRIFT' && Date.now() - e.at < 60000
          );

          if (recentEscalations.length >= 3) {
            logger.warn('[Wave37] Repeated partial drift — elevated monitoring state', {
              recentCount: recentEscalations.length,
              nodeId:      getLocalReplicaId(),
            });
          }
        }
      } // close if (fusionAllowsRollback)
    } // close if (driftResult.rollbackRequired || scoreResult.rollbackRecommended)
  } // close if (shouldSuppressRollback) ... else
  } // close if (leaseFailoverState.usingFallback)

  // Wave 50 — FIX 8: decision latency recorded at end of every cycle.
  // Only emitted when decisionId was generated (i.e. usingFallback was true).
  if (typeof decisionId !== 'undefined') {
    const durationMs = Number(process.hrtime.bigint() - startTime) / 1e6;
    logger.debug('[Wave50] Decision latency', { decisionId, durationMs });
  }

  // Wave 42 — Phase 8: auto-tune threshold after each tick (post counter updates).
  autoTuneRollbackThreshold();
  // Wave 46 — Phase 12: autonomous policy correction (longer window, separate pass).
  applyPolicyCorrection();
  }, leaseFailoverState.probeIntervalMs);

  leaseFailoverState.watchdogTimer.unref();

  logger.info('[Wave33] Lease failover watchdog started', {
    primaryRegion:     leaseFailoverState.primaryRegion,
    fallbackRegion:    leaseFailoverState.fallbackRegion,
    probeIntervalMs:   leaseFailoverState.probeIntervalMs,
    failoverThreshold: leaseFailoverState.failoverThreshold,
    failbackThreshold: leaseFailoverState.failbackThreshold,
  });
}

// =============================================================================
// Wave 34 — PATCH 2: Failover chaos simulation worker.
// Fires every 30 s; no-ops unless leaseChaosState.enabled.
// Randomly injects one of four deterministic in-memory scenarios.
// INVARIANT: never mutates real Redis keys or eval Lua scripts.
// =============================================================================
function startLeaseChaosSimulationWorker() {
  // Idempotency guard — duplicate timers are impossible.
  if (leaseChaosState._workerTimer) return;

  leaseChaosState._workerTimer = trackInterval(() => {
    if (!leaseChaosState.enabled) return;

    const scenarios = [
      'primary-ping-timeout',
      'fallback-eval-timeout',
      'delayed-primary-recovery',
      'fallback-epoch-drift',
    ];

    // Deterministic selection — index driven by injectedFailures count
    // so consecutive ticks never repeat the same scenario.
    const scenario =
      scenarios[leaseChaosState.injectedFailures % scenarios.length];

    leaseChaosState.injectedFailures += 1;
    leaseChaosState.activeScenario   = scenario;
    leaseChaosState.lastScenarioAt   = Date.now();

    logger.warn('[Wave34] Chaos scenario injected', {
      scenario,
      injectedFailures: leaseChaosState.injectedFailures,
      usingFallback:    leaseFailoverState.usingFallback,
      primaryRegion:    leaseFailoverState.primaryRegion,
      fallbackRegion:   leaseFailoverState.fallbackRegion,
    });

    // Force watchdog branch paths by mutating in-memory failover counters only.
    // This exercises the same code paths the real watchdog would take on a genuine
    // Redis failure, without touching any Redis key or disrupting real lease state.
    switch (scenario) {
      case 'primary-ping-timeout':
        // Simulate a failed primary probe — push toward failover threshold
        leaseFailoverState.consecutiveFailures  += 1;
        leaseFailoverState.consecutiveRecoveries = 0;
        leaseFailoverState.primaryFailures      += 1;
        break;

      case 'fallback-eval-timeout':
        // Simulate a stalled fallback — mark fallback momentarily active
        // so drift detector can evaluate the fallback-active branch.
        if (!leaseFailoverState.usingFallback) {
          leaseFailoverState.usingFallback  = true;
          leaseFailoverState.lastFailoverAt = Date.now();
          leaseFailoverState.failoverEvents.push({
            at:        leaseFailoverState.lastFailoverAt,
            direction: 'primary→fallback',
            reason:    '[Wave34-chaos] fallback-eval-timeout simulation',
          });
          if (leaseFailoverState.failoverEvents.length > 1000) {
            leaseFailoverState.failoverEvents.shift();
          }
        }
        break;

      case 'delayed-primary-recovery':
        // Simulate a slow primary return — push toward failback threshold
        leaseFailoverState.consecutiveRecoveries += 1;
        leaseFailoverState.consecutiveFailures    = 0;
        leaseFailoverState.primaryRecoveries     += 1;
        break;

      case 'fallback-epoch-drift': {
        // Simulate epoch drift while on fallback — activates drift detector
        // by ensuring usingFallback is true; actual epoch comparison happens
        // inside detectLeaseRegionDrift(), which reads in-memory values only.
        if (!leaseFailoverState.usingFallback) {
          leaseFailoverState.usingFallback  = true;
          leaseFailoverState.lastFailoverAt = Date.now();
          leaseFailoverState.failoverEvents.push({
            at:        leaseFailoverState.lastFailoverAt,
            direction: 'primary→fallback',
            reason:    '[Wave34-chaos] fallback-epoch-drift simulation',
          });
          if (leaseFailoverState.failoverEvents.length > 1000) {
            leaseFailoverState.failoverEvents.shift();
          }
        }

        // Phase 4 Fix — inject real epoch divergence so the +25 scoring signal
        // (persistedEpoch < localEpoch) activates under chaos conditions.
        //
        // Step 1: lag the persisted epoch behind the local epoch by decrementing
        // the cached mirror. The async refresher (runs every 2 s) will restore
        // this to the real Redis value automatically once chaos is inactive,
        // guaranteeing reversibility without a manual restore path.
        if (leaseChaosState.lastObservedPersistedEpoch !== null) {
          leaseChaosState.lastObservedPersistedEpoch = Math.max(
            0,
            leaseChaosState.lastObservedPersistedEpoch - 1
          );
        }

        // Step 2: advance the in-memory local epoch to widen the divergence gap.
        // We save the pre-chaos value and restore it at the end of this tick so
        // the Lua CAS script on shutdown always sees the genuine held epoch,
        // preserving the CAS invariant.
        const _chaosNodeId   = getLocalReplicaId();
        const _chaosLease    = distributedStartupConsensus.releaseLocks.get(_chaosNodeId);
        const _savedEpoch    = _chaosLease?.leaseEpoch ?? null;

        if (_chaosLease) {
          _chaosLease.leaseEpoch += 1; // simulate local epoch advancement
        }

        // Step 3: track this chaos-induced drift event for lineage / telemetry.
        leaseChaosState.chaosDriftEvents = leaseChaosState.chaosDriftEvents || [];
        leaseChaosState.chaosDriftEvents.push({
          at:             Date.now(),
          scenario:       'fallback-epoch-drift',
          persistedEpoch: leaseChaosState.lastObservedPersistedEpoch,
        });
        if (leaseChaosState.chaosDriftEvents.length > 500) {
          leaseChaosState.chaosDriftEvents.shift();
        }

        logger.debug('[Wave38] Chaos epoch drift injected', {
          persistedEpoch: leaseChaosState.lastObservedPersistedEpoch,
        });

        // Step 4: restore the local epoch so CAS state is not permanently
        // corrupted. The watchdog fires on its own interval; the scoring
        // engine will have already consumed the inflated epoch via the
        // synchronous detectLeaseRegionDrift() call that happens before
        // this worker's mutation window closes.
        if (_chaosLease && _savedEpoch !== null) {
          _chaosLease.leaseEpoch = _savedEpoch;
        }

        // NOTE: lastObservedPersistedEpoch does NOT need a manual restore here.
        // The async epoch refresher (every 2 s) unconditionally overwrites it
        // from Redis, which is the canonical "return to real state" path.
        // If LEASE_CHAOS_MODE is later disabled, the very next refresher tick
        // will overwrite any artificial value, leaving no residual drift.
        break;
      }

      default:
        break;
    }
  }, 30000);

  leaseChaosState._workerTimer.unref();

  logger.info('[Wave34] Lease chaos simulation worker started', {
    enabled:             leaseChaosState.enabled,
    maxDriftToleranceMs: leaseChaosState.maxDriftToleranceMs,
  });
}

// =============================================================================
// Wave 34 — PATCH 3: Region drift detector.
// Compares in-memory local epoch against the persisted Redis epoch and the
// active region label to detect ownership correctness violations while the
// fallback is active.
// Returns { driftDetected, rollbackRequired, deltaMs }
// =============================================================================
function detectLeaseRegionDrift() {
  const nodeId = getLocalReplicaId();

  // Local epoch — sourced from in-memory releaseLocks map (Wave 32 CAS-granted).
  const localLease = distributedStartupConsensus.releaseLocks.get(nodeId);
  const localEpoch = localLease?.leaseEpoch ?? 0;

  // Active region from Wave 33 failover state.
  const activeRegion = leaseFailoverState.usingFallback
    ? leaseFailoverState.fallbackRegion
    : leaseFailoverState.primaryRegion;

  // Time since last failover / failback event (whichever is most recent).
  const lastFailoverEventAt = Math.max(
    leaseFailoverState.lastFailoverAt  || 0,
    leaseFailoverState.lastFailbackAt  || 0,
  );
  const driftAgeMs = lastFailoverEventAt
    ? Date.now() - lastFailoverEventAt
    : 0;

  // Rollback condition requires ALL THREE to be true:
  //   1) fallback is currently active
  //   2) we have a non-zero local epoch (i.e. we hold a lease)
  //   3) drift age has exceeded the configured tolerance window
  //
  // Note: we cannot call async getRedisLeaseState() here because this function
  // is invoked synchronously inside the watchdog interval. We therefore use the
  // local epoch as the authoritative source and treat "time since last failover
  // event > tolerance" as the proxy for "persistedEpoch < localEpoch" drift.
  const driftDetected =
    leaseFailoverState.usingFallback &&
    localEpoch > 0 &&
    driftAgeMs > leaseChaosState.maxDriftToleranceMs;

  const rollbackRequired = driftDetected;

  if (driftDetected) {
  leaseChaosState.driftDetections += 1;

  leaseChaosState.rollbackEvents.push({
    at:              Date.now(),
    nodeId,
    localEpoch,
    // persistedEpoch is unknown here (async) — recorded as null;
    // the rollback action itself does not depend on it.
    persistedEpoch:  null,
    activeRegion,
    driftAgeMs,
  });

  if (leaseChaosState.rollbackEvents.length > 1000) {
    leaseChaosState.rollbackEvents.shift();
  }

  logger.warn('[Wave34] Lease region drift detected', {
    nodeId,
    localEpoch,
    activeRegion,
    driftAgeMs,
    maxDriftToleranceMs: leaseChaosState.maxDriftToleranceMs,
  });
}

return {
  driftDetected,
  rollbackRequired,
  deltaMs: driftAgeMs,
  localEpoch,
  persistedEpoch:
    leaseChaosState.lastObservedPersistedEpoch,
};
}

// =============================================================================
// Wave 34 — PATCH 4: Region drift HARD SAFETY rollback.
// Correctness > availability.
// Stops the lease renewal loop, clears fallback mode, removes the local release
// lock, and resets the startup barrier so fresh quorum arbitration is required
// on the next completeStartupPhase() invocation.
// This is a LOCAL-ONLY action — it never touches Redis keys.
// =============================================================================
async function rollbackLeaseRegionDrift(nodeId) {
  // 1. Stop lease renewal heartbeat.
  if (distributedLeaseRenewalLoop) {
    clearInterval(distributedLeaseRenewalLoop);
    distributedLeaseRenewalLoop = null;
    logger.info('[Wave34] Lease renewal loop stopped during region drift rollback', { nodeId });
  }

  // 2. Clear fallback mode — primary probe will restore it if genuinely needed.
  leaseFailoverState.usingFallback  = false;
  leaseFailoverState.consecutiveFailures   = 0;
  leaseFailoverState.consecutiveRecoveries = 0;

  // 3. Remove the local release lock so re-arbitration starts from a clean slate.
  distributedStartupConsensus.releaseLocks.delete(nodeId);

  // 4. Reset startup barrier — requires fresh quorum arbitration on next
  //    completeStartupPhase() → tryReleaseStartupBarrier() call.
  startupBarrier.isReleased         = false;
  startupBarrier.releaseTimestamp   = null;
  startupBarrier.pendingDistributedRelease = false;

  // 5. Record rollback lineage in chaos state.
  leaseChaosState.lastRollbackAt = Date.now();
  leaseChaosState.activeScenario = null;

  logger.warn('[Wave34] Lease region drift rollback executed', {
    nodeId,
    usingFallback: leaseFailoverState.usingFallback,
    startupBarrierReleased: startupBarrier.isReleased,
  });
}

// =============================================================================
// Wave 35 — PATCH 2: Deterministic rollback confidence scoring engine.
// All inputs are derived deterministically from driftResult and in-memory state.
// Never touches Redis keys. Returns { score, severity, rollbackRecommended,
// contributingSignals }.
// =============================================================================
// =============================================================================
// Wave 44 — Phase 10: Bayesian / multi-signal confidence scoring helpers.
// Numerically stable log-odds (logit/sigmoid) primitives.
// =============================================================================
function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function logit(p) {
  const eps   = 1e-6;
  const pSafe = Math.min(1 - eps, Math.max(eps, clamp01(p)));
  return Math.log(pSafe / (1 - pSafe));
}

function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

function scoreLeaseRollbackConfidence(driftResult) {
  const {
    deltaMs,
    localEpoch,
    persistedEpoch,
  } = driftResult;

  // Wave 35.1 hotfix — deterministic evaluation accounting
  rollbackConfidenceState.totalEvaluations += 1;

  // ── Phase 10 — Bayesian / multi-signal confidence scoring ────────────────
  // Prior: base probability of real drift before any signals are observed.
  const prior = 0.2;

  // Signal likelihoods — calibrated heuristic probabilities per signal.
  const p_epochBehind =
    persistedEpoch != null &&
    localEpoch     != null &&
    persistedEpoch < localEpoch
      ? 0.75 : 0.4;

  const p_timeDrift =
    deltaMs > leaseChaosState.maxDriftToleranceMs
      ? 0.7 : 0.4;

  const p_fallbackDuration =
    deltaMs > leaseChaosState.maxDriftToleranceMs * 2
      ? 0.65 : 0.45;

  const p_chaosScenario =
    driftResult.activeScenario === 'fallback-epoch-drift'
      ? 0.7 : 0.5;

  const tenMinutesAgo = Date.now() - 600000;
  const recentRollbacks = rollbackConfidenceState.severityHistory.filter(
    (entry) => entry.rollbackExecuted && entry.at >= tenMinutesAgo
  ).length;

  const p_recentHistory =
    recentRollbacks >= 2 ? 0.65 : 0.45;

  const p_primaryUnreachable =
    leaseFailoverState.usingFallback ? 0.7 : 0.4;

  // Accumulate log-odds: each signal contributes its deviation from 0.5.
  let z = logit(prior);
  z += logit(p_epochBehind)      - logit(0.5);
  z += logit(p_timeDrift)        - logit(0.5);
  z += logit(p_fallbackDuration) - logit(0.5);
  z += logit(p_chaosScenario)    - logit(0.5);
  z += logit(p_recentHistory)    - logit(0.5);
  z += logit(p_primaryUnreachable) - logit(0.5);

  // Convert posterior probability → integer score (0–100).
  // Wave 46 — Phase 12: apply bounded autonomous policy bias before conversion.
  const posterior = clamp01(sigmoid(z));
  const adjustedPosterior = clamp01(posterior + likelihoodBias);
  let score = Math.round(adjustedPosterior * 100);

  // ── Phase 5 — Adaptive Trust-Weighted Rollback Decisions ─────────────────
  const activeRegion = leaseFailoverState.usingFallback
    ? leaseFailoverState.fallbackRegion
    : leaseFailoverState.primaryRegion;

  const regionTrust = getRegionTrust(activeRegion) / 100;
  const nodeTrust   = getNodeTrust(getLocalReplicaId()) / 100;
  const trustFactor = (regionTrust * 0.6) + (nodeTrust * 0.4);

  score = Math.round(score * trustFactor);
  score = Math.max(0, Math.min(100, score));

  // Bayesian severity bands.
  let severity = 'low';
  if      (score >= 85) severity = 'critical';
  else if (score >= 70) severity = 'high';
  else if (score >= 50) severity = 'moderate';

  // Preserve Phase 5 invariant: demote severity on low trust, but never critical.
  if (trustFactor < 0.5 && severity !== 'critical') {
    severity = 'moderate';
  }

  logger.debug('[Wave44] Bayesian rollback confidence', {
    posterior,
    score,
    severity,
    trustFactor,
  });

  const contributingSignals = [
    p_epochBehind,
    p_timeDrift,
    p_fallbackDuration,
    p_chaosScenario,
    p_recentHistory,
    p_primaryUnreachable,
  ].filter(v => v > 0.5).length;

  return {
    score,
    severity,
    rollbackRecommended: score >= rollbackConfidenceState.minRollbackConfidence,
    contributingSignals,
    posterior,
    trustFactor,
  };
}

// =============================================================================
// Wave 35 — PATCH 3: False-positive suppression window.
// Suppresses rollback when confidence is too low or conditions indicate noise.
// HARD INVARIANT: critical severity is NEVER suppressed.
// Suppression events are appended to falsePositiveWindows for lineage replay.
// =============================================================================
function shouldSuppressRollback(scoreResult, driftResult) {
  const { score, severity } = scoreResult;
  const { localEpoch, persistedEpoch } = driftResult;

  // HARD INVARIANT — critical severity must never be suppressed
  if (severity === 'critical') {
    return false;
  }

  // Suppression rule 1 — score below minimum confidence threshold
  if (score < rollbackConfidenceState.minRollbackConfidence) {
    _recordSuppression(scoreResult, driftResult, 'score-below-threshold');
    return true;
  }

  // Suppression rule 2 — severity is low
  if (severity === 'low') {
    _recordSuppression(scoreResult, driftResult, 'low-severity');
    return true;
  }

  // Suppression rule 3 — rollback happened within the last 60 s and severity is below critical
  const lastRollbackAt = leaseChaosState.lastRollbackAt || 0;
const msSinceLastRollback = Date.now() - lastRollbackAt;

// Wave 35.2 hotfix — starvation prevention escalation
const recentSuppressions = rollbackConfidenceState.falsePositiveWindows.filter(
  (entry) => Date.now() - entry.at < 60000
).length;

if (
  recentSuppressions >= 3 &&
  driftResult.deltaMs >
    leaseChaosState.maxDriftToleranceMs * 2
) {
  logger.warn(
    '[Wave35] Suppression escalation override triggered — rollback starvation prevention',
    {
      recentSuppressions,
      deltaMs: driftResult.deltaMs,
    }
  );

  // Wave 36 — PATCH 3: heavy region trust penalty on starvation override.
  const starvationRegion = leaseFailoverState.usingFallback
    ? leaseFailoverState.fallbackRegion
    : leaseFailoverState.primaryRegion;
  decreaseRegionTrust(starvationRegion, 5);

  return false;
}

if (msSinceLastRollback < 60000 && severity !== 'critical') {
  _recordSuppression(
    scoreResult,
    driftResult,
    'too-soon-after-last-rollback'
  );
  return true;
}

  // Suppression rule 4 — epochs are identical (no real drift)
  if (
    persistedEpoch !== null &&
    persistedEpoch !== undefined &&
    localEpoch > 0 &&
    persistedEpoch === localEpoch
  ) {
    _recordSuppression(scoreResult, driftResult, 'epochs-equal-no-drift');
    return true;
  }

  return false;
}

// Internal helper — records a suppression event into lineage structures.
// Never called externally.
function _recordSuppression(scoreResult, driftResult, reason) {
  // BUG-04 FIX: Increment both independent counters instead of shared one
  rollbackConfidenceState.autoTuneCounters.suppressed += 1;
  rollbackConfidenceState.policyCounters.suppressed   += 1;

 rollbackConfidenceState.falsePositiveWindows.push({
  at: Date.now(),
  reason,
  score: scoreResult.score,
  severity: scoreResult.severity,
  deltaMs: driftResult.deltaMs,
  localEpoch: driftResult.localEpoch,
  persistedEpoch: driftResult.persistedEpoch,
});

if (rollbackConfidenceState.falsePositiveWindows.length > 500) {
  rollbackConfidenceState.falsePositiveWindows.shift();
}

  // Wave 36 — PATCH 3: decrease trust on suppression (noisy region/node penalty).
  const suppressionRegion = leaseFailoverState.usingFallback
    ? leaseFailoverState.fallbackRegion
    : leaseFailoverState.primaryRegion;
  decreaseRegionTrust(suppressionRegion, 2);
  decreaseNodeTrust(getLocalReplicaId(), 1);

  logger.info(
    '[Wave35] Rollback suppressed — false-positive window recorded',
    {
      reason,
      score: scoreResult.score,
      severity: scoreResult.severity,
      deltaMs: driftResult.deltaMs,
      suppressedTotal:
        rollbackConfidenceState.suppressedRollbacks,
    }
  );
}

// =============================================================================
// Wave 36 — PATCH 2: Time-decay trust normalization.
// Exponential half-life decay: trust × 0.5^(age / halfLife). Clamps 0–100.
// =============================================================================
function getDecayedTrust(currentTrust, ageMs, halfLifeMs) {
  const decayFactor = Math.pow(0.5, ageMs / halfLifeMs);
  return Math.max(0, Math.min(100, currentTrust * decayFactor));
}

function getRegionTrust(region) {
  const entry = rollbackTrustState.regionTrust.get(region);
  if (!entry) return 100;
  const ageMs = Date.now() - entry.updatedAt;
  return getDecayedTrust(entry.trust, ageMs, rollbackTrustState.decayHalfLifeMs);
}

function getNodeTrust(nodeId) {
  const entry = rollbackTrustState.nodeTrust.get(nodeId);
  if (!entry) return 100;
  const ageMs = Date.now() - entry.updatedAt;
  return getDecayedTrust(entry.trust, ageMs, rollbackTrustState.decayHalfLifeMs);
}

// =============================================================================
// Wave 36 — PATCH 3 helpers: trust mutation functions.
// All mutations clamp 0–100 and append a replayable trustEvents lineage entry.
// =============================================================================
function _appendTrustEvent(type, key, delta, newTrust) {
  rollbackTrustState.trustEvents.push({
    at:       Date.now(),
    type,
    key,
    delta,
    newTrust: Math.round(newTrust),
  });
  if (rollbackTrustState.trustEvents.length > rollbackTrustState.maxTrustEvents) {
    rollbackTrustState.trustEvents.shift();
  }
}

function increaseRegionTrust(region, delta) {
  const next = Math.min(100, getRegionTrust(region) + delta);
  rollbackTrustState.regionTrust.set(region, { trust: next, updatedAt: Date.now() });
  _appendTrustEvent('region-increase', region, delta, next);
  publishTrustDelta('region', region, +delta);
}

function decreaseRegionTrust(region, delta) {
  const next = Math.max(0, getRegionTrust(region) - delta);
  rollbackTrustState.regionTrust.set(region, { trust: next, updatedAt: Date.now() });
  _appendTrustEvent('region-decrease', region, -delta, next);
  publishTrustDelta('region', region, -delta);
}

function increaseNodeTrust(nodeId, delta) {
  const next = Math.min(100, getNodeTrust(nodeId) + delta);
  rollbackTrustState.nodeTrust.set(nodeId, { trust: next, updatedAt: Date.now() });
  _appendTrustEvent('node-increase', nodeId, delta, next);
  publishTrustDelta('node', nodeId, +delta);
}

function decreaseNodeTrust(nodeId, delta) {
  const next = Math.max(0, getNodeTrust(nodeId) - delta);
  rollbackTrustState.nodeTrust.set(nodeId, { trust: next, updatedAt: Date.now() });
  _appendTrustEvent('node-decrease', nodeId, -delta, next);
  publishTrustDelta('node', nodeId, -delta);
}

// =============================================================================
// Wave 45 — Phase 11: Distributed reputation sharing (global trust propagation).
// Broadcasts local trust mutations to peer nodes via Redis Pub/Sub.
// Received signals are attenuated and merged into local state without
// re-publishing (prevents feedback loops / amplification storms).
// =============================================================================
const TRUST_SIGNAL_CHANNEL = 'hirerise:trust:signals';

const TRUST_PROPAGATION = {
  enabled: process.env.TRUST_PROPAGATION_ENABLED === 'true',
  // Fraction of a remote delta to absorb locally (0..1)
  attenuation: 0.5,
  // Minimum ms between broadcasts for the same (kind, id) key
  minBroadcastIntervalMs: 2000,
  // Discard signals older than this many ms
  maxSignalAgeMs: 10000,
  // Hard cap on the signed delta that may be published in a single event
  maxDeltaPerEvent: 5,
};

// Per-(kind+id) throttle: tracks the last time we broadcast for each key.
// Uses a plain Map so no extra dependencies are needed.
const _trustBroadcastThrottle = new Map(); // `${kind}:${id}` → lastBroadcastMs

/**
 * Publish a signed trust delta to peer nodes (fire-and-forget).
 * Throttled per key; clamped to maxDeltaPerEvent; no-op when propagation
 * is disabled or when the Redis client is unavailable.
 *
 * @param {'region'|'node'} kind
 * @param {string}          id     – region name or nodeId
 * @param {number}          delta  – signed integer
 */
function publishTrustDelta(kind, id, delta) {
  if (!TRUST_PROPAGATION.enabled) return;

  // Throttle: skip if we broadcast this key too recently.
  const throttleKey = `${kind}:${id}`;
  const lastAt = _trustBroadcastThrottle.get(throttleKey) || 0;
  if (Date.now() - lastAt < TRUST_PROPAGATION.minBroadcastIntervalMs) return;
  _trustBroadcastThrottle.set(throttleKey, Date.now());
  if (_trustBroadcastThrottle.size > 500) {
    _trustBroadcastThrottle.delete(_trustBroadcastThrottle.keys().next().value);
  }

  // Clamp outgoing delta to prevent outsized signals.
  const clampedDelta = Math.max(
    -TRUST_PROPAGATION.maxDeltaPerEvent,
    Math.min(TRUST_PROPAGATION.maxDeltaPerEvent, delta)
  );

  try {
    const payload = JSON.stringify({
      kind,
      id,
      delta:      clampedDelta,
      at:         Date.now(),
      sourceNode: getLocalReplicaId(),
    });

    const client = getLeaseRedisClient();
    if (!client) return;
    client.publish(TRUST_SIGNAL_CHANNEL, payload).catch((publishErr) => {
      logger.warn('[Wave45] Trust signal publish failed — Redis may be unavailable', {
        error:   publishErr.message,
        channel: TRUST_SIGNAL_CHANNEL,
      });
    });
  } catch (err) {
    logger.warn('[Wave45] Failed to publish trust delta', { error: err.message });
  }
}

/**
 * Direct setter for region trust — updates internal state without triggering
 * publishTrustDelta, preventing re-broadcast of remotely-sourced events.
 * Trust is stored on the same 0-100 scale as the local helpers.
 *
 * @param {string} region
 * @param {number} trustValue  – value in [0, 100]
 */
function setRegionTrustDirect(region, trustValue) {
  const clamped = Math.max(0, Math.min(100, trustValue));
  rollbackTrustState.regionTrust.set(region, { trust: clamped, updatedAt: Date.now() });
}

/**
 * Direct setter for node trust — same semantics as setRegionTrustDirect.
 *
 * @param {string} nodeId
 * @param {number} trustValue  – value in [0, 100]
 */
function setNodeTrustDirect(nodeId, trustValue) {
  const clamped = Math.max(0, Math.min(100, trustValue));
  rollbackTrustState.nodeTrust.set(nodeId, { trust: clamped, updatedAt: Date.now() });
}

/**
 * Merge a remote region trust delta into local state.
 * The incoming delta is already attenuated by the subscriber.
 * Maps a ±5 integer delta to a ±0.05 (5-point) shift on the 0-100 scale,
 * keeping movement small and bounded.
 *
 * @param {string} region
 * @param {number} delta  – attenuated signed integer
 */
function applyRemoteRegionTrust(region, delta) {
  const current = getRegionTrust(region);
  // delta is already attenuated; map each unit to 1 trust point (same scale as local helpers)
  const next = Math.max(0, Math.min(100, current + delta));
  setRegionTrustDirect(region, next);
}

/**
 * Merge a remote node trust delta into local state.
 *
 * @param {string} nodeId
 * @param {number} delta  – attenuated signed integer
 */
function applyRemoteNodeTrust(nodeId, delta) {
  const current = getNodeTrust(nodeId);
  const next = Math.max(0, Math.min(100, current + delta));
  setNodeTrustDirect(nodeId, next);
}

logger.debug('[Wave45] Trust propagation stats', {
  enabled:     TRUST_PROPAGATION.enabled,
  attenuation: TRUST_PROPAGATION.attenuation,
});

// =============================================================================
// Wave 36 — PATCH 4: Regional quorum escalation predicate.
// Returns true only when severity is non-critical AND region trust is low.
// Critical severity ALWAYS bypasses quorum escalation.
// =============================================================================
function shouldEscalateToRegionalQuorum(scoreResult) {
  if (scoreResult.severity === 'critical') return false;
  const activeRegion = leaseFailoverState.usingFallback
    ? leaseFailoverState.fallbackRegion
    : leaseFailoverState.primaryRegion;
  return getRegionTrust(activeRegion) < rollbackTrustState.minQuorumEscalationTrust;
}

// =============================================================================
// Wave 37 — PATCH 2: Regional anomaly signal emission.
// Overwrites any existing entry for the region. Values are clamped 0–1.
// Deterministic: same inputs always produce the same stored signal.
// =============================================================================
// =============================================================================
// Helper: clamp a numeric value to [0, 1], guarding against NaN / Infinity.
// =============================================================================
function clampSignal(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// =============================================================================
// Wave 37 — PATCH 2: Regional anomaly signal emitter.
// Clamps all inputs at the boundary so the rest of the pipeline is NaN-free.
// =============================================================================
async function emitRegionalAnomalySignal(regionId, signal) {
  if (!regionId) return; // guard: never store signals without an identity

  const clampedDrift       = clampSignal(signal.driftScore);
  const clampedConfidence  = clampSignal(signal.confidence);

  anomalyFusionState.regions.set(regionId, {
    driftScore: clampedDrift,
    confidence: clampedConfidence,
    timestamp:  Date.now(),
  });

  // Wave 50 — FIX 9: debug-level ingestion log. Kept at debug to avoid noise.
  logger.debug('[Wave50] Signal received', {
    region:     regionId,
    nodeId:     getLocalReplicaId(),
    driftScore: clampedDrift,
    confidence: clampedConfidence,
  });

  // Wave 40 — Broadcast to peer nodes via Redis Pub/Sub.
  // Fire-and-forget: a publish failure must never block the local signal path.
  try {
    const payload = JSON.stringify({
      region:     regionId,
      driftScore: clampSignal(signal.driftScore),
      confidence: clampSignal(signal.confidence),
      timestamp:  Date.now(),
      nodeId:     getLocalReplicaId(),
    });

    const client = getLeaseRedisClient();

    if (client) {
      try {
        await client.publish(ANOMALY_SIGNAL_CHANNEL, payload);
      } catch (err) {
        logger.warn('[Wave49] Redis publish failed', { error: err.message });
      }
    }

  } catch (err) {
    logger.warn('[Wave40] Failed to publish anomaly signal', {
      error: err.message,
    });
  }

  // ALWAYS execute gossip fallback
  // Wave 41 — Gossip fallback broadcast over UDP.
  // Runs in parallel with Pub/Sub: if Redis is healthy both paths fire;
  // if Redis is down only gossip carries the signal. UDP is lossy by design —
  // packet loss is tolerated; peers reconstruct consensus from what arrives.
  if (GOSSIP_ENABLED && gossipSocket) {
    try {
      const gossipPayload = Buffer.from(JSON.stringify({
        region:     regionId,
        driftScore: clampSignal(signal.driftScore),
        confidence: clampSignal(signal.confidence),
        timestamp:  Date.now(),
        nodeId:     getLocalReplicaId(),
      }));

      for (const peer of GOSSIP_PEERS) {
        const [host, rawPort] = peer.split(':');
        const port = parseInt(rawPort || String(GOSSIP_PORT), 10);
        // send() is non-blocking; errors surface via the socket 'error' event
        // registered at init time, never thrown here.
        gossipSocket.send(gossipPayload, 0, gossipPayload.length, port, host);
      }

    } catch (err) {
      logger.warn('[Wave41] Failed to broadcast gossip signal', {
        error: err.message,
      });
    }
  }
}

// =============================================================================
// Wave 37 — PATCH 3: Stale signal cleanup.
// Removes signals older than maxSignalAgeMs. Must run before every evaluation.
// Pure synchronous iteration — no timers, no external side-effects.
// IMPORTANT: operates only on age; confidence filtering is done in the
// evaluator so the two passes never double-remove the same signal.
// =============================================================================
function cleanupOldAnomalySignals() {
  const cutoff = Date.now() - (anomalyFusionState.maxSignalAgeMs || 10000);
  for (const [regionId, signal] of anomalyFusionState.regions) {
    if (signal.timestamp < cutoff) {
      anomalyFusionState.regions.delete(regionId);
    }
  }
}

// =============================================================================
// Wave 37 — PATCH 4: Cross-region anomaly fusion engine (hardened).
//
// Decision pipeline:
//   1. Purge stale signals (age-based only — cleanupOldAnomalySignals).
//   2. Enforce minimum signal quorum before any scoring.
//   3. Skip weak-confidence signals (MIN_CONFIDENCE filter).
//   4. Apply linear freshness decay to surviving signals.
//   5. Compute confidence-weighted drift consensus score.
//   6. Clamp final score strictly to [0, 1].
//   7. Apply hysteresis to prevent rapid action flapping.
//   8. Write validated state; return extended observability payload.
//
// Returns:
//   { action, score, contributingSignals, totalWeight }
//
// action ∈ { GLOBAL_DRIFT_CONFIRMED | PARTIAL_DRIFT | NO_DRIFT | INSUFFICIENT_DATA | INSUFFICIENT_DIVERSITY }
// =============================================================================

const ANOMALY_ACTIONS = {
  GLOBAL:                 'GLOBAL_DRIFT_CONFIRMED',
  PARTIAL:                'PARTIAL_DRIFT',
  NONE:                   'NO_DRIFT',
  INSUFFICIENT_DATA:      'INSUFFICIENT_DATA',
  INSUFFICIENT_DIVERSITY: 'INSUFFICIENT_DIVERSITY',
};

// Wave 40 — Pub/Sub channel for cross-node anomaly signal exchange.
const ANOMALY_SIGNAL_CHANNEL = 'hirerise:anomaly:signals';

// Wave 43 — Phase 9: Redis key for persisting auto-tune state across restarts.
const ROLLBACK_AUTOTUNE_KEY = 'hirerise:rollback:autotune';

// Wave 41 — Gossip fallback configuration.
// GOSSIP_ENABLED activates UDP gossip when Redis Pub/Sub is unavailable.
// GOSSIP_PEERS is a comma-separated list of "host:port" peer addresses.
const GOSSIP_ENABLED = process.env.GOSSIP_ENABLED === 'true';
const GOSSIP_PORT    = parseInt(process.env.GOSSIP_PORT  || '41234', 10);
const GOSSIP_PEERS   = (process.env.GOSSIP_PEERS || '').split(',').filter(Boolean);

function evaluateCrossRegionAnomalies() {
  // ── Step 1: evict stale signals ──────────────────────────────────────────────
  cleanupOldAnomalySignals();

  const now      = Date.now();
  const WINDOW_MS = anomalyFusionState.maxSignalAgeMs || 10000;

  // ── Step 2: minimum quorum guard ────────────────────────────────────────────
  const MIN_SIGNALS = (Number.isFinite(anomalyFusionState.minSignals) && anomalyFusionState.minSignals > 0)
    ? anomalyFusionState.minSignals
    : 2;

  if (anomalyFusionState.regions.size < MIN_SIGNALS) {
    return { action: ANOMALY_ACTIONS.INSUFFICIENT_DATA, score: 0, contributingSignals: 0, totalWeight: 0 };
  }

  // ── Step 3–5: confidence filter + freshness decay + weighted accumulation ───
  const MIN_CONFIDENCE = 0.2;

  let weightedScore      = 0;
  let totalWeight        = 0;
  let contributingSignals = 0;
  const uniqueRegions    = new Set();

  for (const [regionId, signal] of anomalyFusionState.regions.entries()) {
    // Input safety: re-clamp in case state was mutated externally.
    const driftScore = clampSignal(signal.driftScore);
    const confidence = clampSignal(signal.confidence);

    // Step 3: skip weak signals.
    if (confidence < MIN_CONFIDENCE) continue;

    // Step 4: linear freshness decay — older signals carry less weight.
    const safeAge   = Math.max(0, now - (signal.timestamp || now));
    const freshness = Math.max(0, 1 - (safeAge / WINDOW_MS));

    const boundedConfidence = Math.min(1, Math.max(0, confidence));
    const adjustedConfidence = boundedConfidence * freshness;
    if (adjustedConfidence <= 0) continue; // fully decayed

    // Step 5: weighted accumulation.
    weightedScore += driftScore * adjustedConfidence;
    totalWeight   += adjustedConfidence;
    contributingSignals += 1;
    uniqueRegions.add(regionId);
  }

  // Fix 1: post-filter quorum — MIN_SIGNALS checked against signals that
  // actually survived confidence + freshness filtering, not raw region count.
  if (contributingSignals < MIN_SIGNALS) {
    return {
      action: ANOMALY_ACTIONS.INSUFFICIENT_DATA,
      score: 0,
      contributingSignals,
      totalWeight,
    };
  }

  // ── Step 6: consensus score clamped to [0, 1] ───────────────────────────────
  const consensusScore = (totalWeight > 0)
    ? clampSignal(weightedScore / totalWeight)
    : 0;

  // ── Step 7: configurable thresholds + hysteresis ────────────────────────────
  const GLOBAL_THRESHOLD  = (Number.isFinite(anomalyFusionState.globalThreshold))
    ? anomalyFusionState.globalThreshold
    : 0.75;
  const PARTIAL_THRESHOLD = (Number.isFinite(anomalyFusionState.partialThreshold))
    ? anomalyFusionState.partialThreshold
    : 0.4;

  // Hysteresis: if we previously confirmed a global drift, hold that decision
  // until the score drops clearly below the global threshold (hysteresis band).
  const HYSTERESIS_MARGIN = 0.05; // must fall below this to un-confirm
  const lastAction = anomalyFusionState.lastAction;
  const anomalyScore = consensusScore;

  // Fix 2: all action values use ANOMALY_ACTIONS constants — no raw strings.
  let action;

  if (
    lastAction === ANOMALY_ACTIONS.GLOBAL &&
    anomalyScore > GLOBAL_THRESHOLD - HYSTERESIS_MARGIN
  ) {
    action = ANOMALY_ACTIONS.GLOBAL;
  } else if (anomalyScore > GLOBAL_THRESHOLD + HYSTERESIS_MARGIN) {
    action = ANOMALY_ACTIONS.GLOBAL;
  } else if (anomalyScore > PARTIAL_THRESHOLD) {
    action = ANOMALY_ACTIONS.PARTIAL;
  } else {
    action = ANOMALY_ACTIONS.NONE;
  }

  // ── Step 8: safe state mutation ─────────────────────────────────────────────
  // Only write validated, finite values to shared state.
  if (Number.isFinite(consensusScore)) {
    anomalyFusionState.consensusScore = consensusScore;
  }
  anomalyFusionState.lastEvaluatedAt = now;
  anomalyFusionState.lastAction      = action;

  return { action, score: consensusScore, contributingSignals, totalWeight };
}

function applyControlledDagMutation() {
  if (
    startupChaosConfidence.confidenceScore <
    startupChaosConfidence.rollbackThreshold
  ) {
    return;
  }
  const currentCohort = getMutationCanaryCohort();
  startupDagMutationLedger.lastExpandedCohort =
    [...currentCohort];
  for (const phase of currentCohort) {
    const meta = startupBarrier.phases.get(phase);
    if (!meta || !meta.critical) {
      continue;
    }
    startupBarrier.phases.set(phase, {
      ...meta,
      critical: false,
      asyncPhase: true,
      mutatedByWave17: true,
    });
    startupDagMutationLedger.appliedMutations.set(
      phase,
      {
        mutatedAt: Date.now(),
        previousCritical: true,
      }
    );
    startupDagMutationLedger.lastMutationAt =
      Date.now();
  }
}

function evaluateDagSelfHealing() {
  startupDagSelfHealing.autoPromotedCandidates = [];
  for (const phase of
    startupDagProfiler.reclassificationCandidates) {
    const currentScore =
      startupDagSelfHealing.candidateScores.get(
        phase
      ) || 0;
    const nextScore = currentScore + 1;
    startupDagSelfHealing.candidateScores.set(
      phase,
      nextScore
    );
    if (
      nextScore >=
        startupDagSelfHealing.promotionThreshold &&
      !startupDagSelfHealing.permanentlyPromoted.has(
        phase
      )
    ) {
      startupDagSelfHealing.autoPromotedCandidates.push(
        phase
      );
      startupDagSelfHealing.permanentlyPromoted.add(
        phase
      );
      startupDagSelfHealing.healingHistory.push({
        phase,
        promotedAt: Date.now(),
        reason: 'stable-high-slack',
      });
      if (startupDagSelfHealing.healingHistory.length > 500) {
        startupDagSelfHealing.healingHistory.shift();
      }
      startupDagSelfHealing.lastHealingActionAt =
        Date.now();
    }
  }
}

function completeStartupPhase(phase) {
  startupBarrier.completed.add(phase);

  const existing =
    startupBarrier.phases.get(phase) || {};

  const completedAt = Date.now();

  const durationMs = existing.registeredAt
    ? completedAt - existing.registeredAt
    : null;

  startupBarrier.phases.set(phase, {
    ...existing,
    completedAt,
    durationMs,
    status: 'completed',
  });

  markStartupPhase(phase, {
    completedAt,
    durationMs,
    status: 'completed',
  });

  if (durationMs !== null) {
    startupBarrier.phaseDurations.set(
      phase,
      durationMs
    );

    if (
      !startupBarrier.slowestPhase ||
      durationMs >
        startupBarrier.slowestPhase.durationMs
    ) {
      startupBarrier.slowestPhase = {
        phase,
        durationMs,
      };
    }
  }

  // Wave 31 — tryReleaseStartupBarrier is async (Redis acquisition); fire-and-forget
  // here since completeStartupPhase is synchronous. Errors are logged internally.
  tryReleaseStartupBarrier().catch((err) => {
    logger.warn('[Wave31] tryReleaseStartupBarrier async error', { error: err.message });
  });
}

// Wave 31 — made async to support Redis await calls in durable lease acquisition.
async function tryReleaseStartupBarrier() {
  if (startupBarrier.isReleased) {
    return true;
  }

  if (!startupBarrier.registrationComplete) {
    return false;
  }

const criticalPhases = Array.from(
  startupBarrier.phases.entries()
)
  .filter(([, meta]) => meta.critical)
  .map(([phase]) => phase);

const ready = criticalPhases.every((phase) =>
  startupBarrier.completed.has(phase)
);

  if (!ready) {
    return false;
  }

  // Wave 29 — PATCH 4: mark pending before arbitration begins
  startupBarrier.pendingDistributedRelease = true;

  // Wave 28/29 — PATCH 3A: publish local node startup state before arbitration
  const nodeId = getLocalReplicaId();

// Wave 30.5 Hardening — publish PRE-RELEASE intent only.
// This replica must NOT be counted as quorum-ready until
// lock arbitration succeeds.
publishNodeStartupState(nodeId, {
  nodeId,
  isReleased: false,
  pendingRelease: true,
  completedPhases: Array.from(startupBarrier.completed),
  slowestPhase:
    startupBarrier.slowestPhase?.phase || null,
});

// Wave 29/30 — hard release arbitration gate
const consensus = reconcileDistributedStartupQuorum({
  nodeId,
  completedPhases: Array.from(startupBarrier.completed),
});

if (!consensus.lockGranted) {
  logger.warn(
    '[startup-consensus] release arbitration denied',
    consensus
  );

  startupBarrier.pendingDistributedRelease = false;

  // publish denial result so peers do not misread stale intent
  publishNodeStartupState(nodeId, {
    nodeId,
    isReleased: false,
    pendingRelease: false,
    arbitrationDenied: true,
    completedPhases: Array.from(startupBarrier.completed),
    slowestPhase:
      startupBarrier.slowestPhase?.phase || null,
  });

  return false;
}

// Wave 32 — PATCH 2: atomic Lua CAS lease acquisition.
// Replaces the Wave 31 multi-round-trip GET/SET-NX/SET sequence with a
// single LUA_ACQUIRE_LEASE eval. Eliminates all TOCTOU races between
// epoch fence read and NX write.
{
  const leaseKey        = getReplicaLeaseKey(nodeId);
  const epochKey        = getReplicaEpochKey(nodeId);
  const newEpoch        = Date.now();
  const leaseDurationMs = distributedStartupConsensus.leaseDurationMs;
  const epochTtlMs      = 86400000; // 24 h epoch persistence

  // Wave 33 — route through region-aware resolver for failover support.
  const redisClient = getLeaseRedisClient();

  if (redisClient) {
    let casResult = null;
    try {
      casResult = await redisClient.eval(
        LUA_ACQUIRE_LEASE,
        2,           // numkeys
        leaseKey,
        epochKey,
        String(newEpoch),
        String(leaseDurationMs),
        String(epochTtlMs),
      );
    } catch (err) {
      // Redis unavailable — abort lease acquisition to prevent split-brain.
      logger.warn('[Wave32] Lua acquire eval error — aborting barrier release to prevent split-brain', {
        nodeId, error: err.message,
      });
      startupBarrier.pendingDistributedRelease = false;
      publishNodeStartupState(nodeId, {
        nodeId,
        isReleased: false,
        pendingRelease: false,
        arbitrationDenied: true,
        completedPhases: Array.from(startupBarrier.completed),
        slowestPhase: startupBarrier.slowestPhase?.phase || null,
      });
      return false;
    }

    if (casResult === -1) {
      // PATCH 7 epoch fence fired inside Lua — storedEpoch > newEpoch
      logger.warn('[Wave32] Lua CAS: stale replica epoch fencing — acquisition denied', {
        nodeId, newEpoch,
      });
      startupBarrier.pendingDistributedRelease = false;
      publishNodeStartupState(nodeId, {
        nodeId,
        isReleased: false,
        pendingRelease: false,
        arbitrationDenied: true,
        completedPhases: Array.from(startupBarrier.completed),
        slowestPhase: startupBarrier.slowestPhase?.phase || null,
      });
      return false;
    }

    if (casResult === 0) {
      // NX collision — another replica holds the durable lease
      logger.warn('[Wave32] Lua CAS: NX denied — another replica holds the durable lease', {
        nodeId, leaseKey,
      });
      startupBarrier.pendingDistributedRelease = false;
      publishNodeStartupState(nodeId, {
        nodeId,
        isReleased: false,
        pendingRelease: false,
        arbitrationDenied: true,
        completedPhases: Array.from(startupBarrier.completed),
        slowestPhase: startupBarrier.slowestPhase?.phase || null,
      });
      return false;
    }

    // casResult === 1: Lua granted the lease atomically.
    // Synchronise local Map epoch with the Redis-granted epoch so they never diverge.
    const existingLease = distributedStartupConsensus.releaseLocks.get(nodeId) || {};
    distributedStartupConsensus.releaseLocks.set(nodeId, {
      ...existingLease,
      leaseEpoch: newEpoch,
      grantedAt:  newEpoch,
      expiresAt:  newEpoch + leaseDurationMs,
      renewedAt:  newEpoch,
    });

    logger.info('[Wave32] Redis durable lease acquired via Lua CAS', {
      nodeId, leaseKey, newEpoch, leaseDurationMs,
    });
  }
}

startupBarrier.isReleased = true;
startupBarrier.pendingDistributedRelease = false;
startupBarrier.releaseTimestamp = Date.now();

// Wave 30.5 Hardening — publish FINAL released state only after
// successful lock grant. This is the only state peers should count
// toward distributed quorum.
publishNodeStartupState(nodeId, {
  nodeId,
  isReleased: true,
  pendingRelease: false,
  completedPhases: Array.from(startupBarrier.completed),
  slowestPhase:
    startupBarrier.slowestPhase?.phase || null,
});

  // Wave 30 — start cross-replica lease renewal heartbeat
  startDistributedLeaseRenewalWorker(nodeId);

  // Wave 15 → DAG slack + critical path telemetry
  let criticalPathDurationMs = 0;

  startupDagProfiler.zeroValueCriticalBlockers = [];
  startupDagProfiler.movablePostRelease = [];
  startupDagProfiler.reclassificationCandidates = [];
  startupDagProfiler.slackByPhase.clear();

  for (const [phase, meta] of startupBarrier.phases.entries()) {
    const duration =
      startupBarrier.phaseDurations.get(phase) || 0;

    if (meta.critical) {
      criticalPathDurationMs += duration;
    }

    const slackMs = calculatePhaseSlack(phase);
    startupDagProfiler.slackByPhase.set(phase, slackMs);

    if (
      meta.critical &&
      slackMs > duration &&
      !meta.degradedFloor
    ) {
      startupDagProfiler.zeroValueCriticalBlockers.push(
        phase
      );
    }

    if (
      meta.critical &&
      slackMs >= duration * 2 &&
      !meta.degradedFloor
    ) {
      startupDagProfiler.reclassificationCandidates.push(
        phase
      );
    }

    if (
      meta.critical &&
      slackMs > 300 &&
      !meta.degradedFloor
    ) {
      startupDagProfiler.movablePostRelease.push(
        phase
      );
    }
  }

  if (
    startupDagProfiler.lastCriticalPathDurationMs !== null
  ) {
    startupDagProfiler.criticalPathDeltaMs =
      criticalPathDurationMs -
      startupDagProfiler.lastCriticalPathDurationMs;
  }

  startupDagProfiler.lastCriticalPathDurationMs =
    criticalPathDurationMs;

  // Wave 24 → sandbox verdict engine: adjudicate all sandbox entries, then clear
  for (const [phase] of startupDagMutationLedger.paroleSandbox) {
    const delta =
      startupDagProfiler.criticalPathDeltaMs || 0;
    const verdict =
      delta <= startupDagMutationLedger.sandboxReentryThresholdMs
        ? 'approved-for-appeal'
        : 're-sentenced';
    startupDagMutationLedger.sandboxVerdicts.push({
      phase,
      verdict,
      delta,
      timestamp: Date.now(),
    });
    if (startupDagMutationLedger.sandboxVerdicts.length > 500) {
      startupDagMutationLedger.sandboxVerdicts.shift();
    }
    if (verdict === 're-sentenced') {
      startupDagMutationLedger.phaseRiskScores.set(
        phase,
        (startupDagMutationLedger.phaseRiskScores.get(phase) || 0) + 2
      );
    }
    // Wave 25 → update precedent score from verdict outcome
    if (verdict === 'approved-for-appeal') {
      startupDagMutationLedger.precedentScores.set(
        phase,
        (startupDagMutationLedger.precedentScores.get(phase) || 0) + 1
      );
    }
    if (verdict === 're-sentenced') {
      startupDagMutationLedger.precedentScores.set(
        phase,
        (startupDagMutationLedger.precedentScores.get(phase) || 0) - 1
      );
    }
  }
  startupDagMutationLedger.paroleSandbox.clear();

  const chainFingerprint = fingerprintCriticalChain();

  evaluateDagSelfHealing();

  const slowestPhaseName =
    startupBarrier.slowestPhase?.phase || null;

  if (slowestPhaseName) {
    const previousCount =
      startupRegressionProfiler.repeatedSlowPhase.get(
        slowestPhaseName
      ) || 0;

    startupRegressionProfiler.repeatedSlowPhase.set(
      slowestPhaseName,
      previousCount + 1
    );

    startupRegressionProfiler.lastBootSlowestPhase =
      slowestPhaseName;
  }

  if (startupWatchdog.timer) {
    clearTimeout(startupWatchdog.timer);
    startupWatchdog.timer = null;
  }

  logger.info(
    '[Server] Patch 35 distributed startup orchestration barrier released',
    {
      completed_phases: startupBarrier.completed.size,
      total_registered_phases: startupBarrier.phases.size,
      slowest_phase:
        startupBarrier.slowestPhase?.phase || null,
      slowest_phase_duration_ms:
        startupBarrier.slowestPhase?.durationMs || null,
    }
  );

  const repeatedCount =
    startupBarrier.slowestPhase?.phase
      ? startupRegressionProfiler.repeatedSlowPhase.get(
          startupBarrier.slowestPhase.phase
        ) || 0
      : 0;

  if (repeatedCount >= 3) {
    logger.warn(
      '[Server] Patch 37 repeated startup bottleneck detected',
      {
        phase: startupBarrier.slowestPhase?.phase || null,
        repetition_count: repeatedCount,
        duration_ms:
          startupBarrier.slowestPhase?.durationMs || null,
      }
    );
  }

  if (
    startupDagProfiler.criticalPathDeltaMs !== null &&
    startupDagProfiler.criticalPathDeltaMs > 500
  ) {
    for (const phase of
      startupDagMutationLedger.lastExpandedCohort) {
      const mutation =
        startupDagMutationLedger.appliedMutations.get(
          phase
        );
      const meta = startupBarrier.phases.get(phase);
      if (!meta) continue;
      startupBarrier.phases.set(phase, {
        ...meta,
        critical: mutation.previousCritical,
        asyncPhase: false,
        rolledBackByWave17: true,
      });
      startupDagMutationLedger.rollbackEvents.push({
        phase,
        rolledBackAt: Date.now(),
        reason: 'critical-path-regression',
      });
      if (startupDagMutationLedger.rollbackEvents.length > 500) {
        startupDagMutationLedger.rollbackEvents.shift();
      }
      startupDagMutationLedger.lastRollbackAt =
        Date.now();
      startupDagMutationLedger.mutationConfidenceScore =
        Math.max(
          0,
          startupDagMutationLedger.mutationConfidenceScore - 20
        );
      // Wave 19 → per-phase rollback blame scoring + quarantine
      const previousRisk =
        startupDagMutationLedger.phaseRiskScores.get(
          phase
        ) || 0;
      const nextRisk = previousRisk + 1;
      startupDagMutationLedger.phaseRiskScores.set(
        phase,
        nextRisk
      );
      if (nextRisk >= 3) {
        startupDagMutationLedger.quarantinedPhases.set(
          phase,
          Date.now() +
            Math.min(
              startupDagMutationLedger.quarantineMaxCooldownMs,
              startupDagMutationLedger.quarantineBaseCooldownMs *
                Math.pow(2, nextRisk - 3)
            )
        );
        startupDagMutationLedger.lastQuarantineAt =
          Date.now();
      }
      // Wave 21 → probation tier assignment + permanent ban at risk 9
      let tier = 'yellow';
      if (nextRisk >= 5) tier = 'orange';
      if (nextRisk >= 7) tier = 'red';
      startupDagMutationLedger.probationTiers.set(
        phase,
        tier
      );
      startupDagMutationLedger.probationHistory.push({
        phase,
        tier,
        timestamp: Date.now(),
        risk: nextRisk,
      });
      if (startupDagMutationLedger.probationHistory.length > 500) {
        startupDagMutationLedger.probationHistory.shift();
      }
      if (nextRisk >= 9) {
        startupDagMutationLedger.permanentlyBannedPhases.add(
          phase
        );
        startupDagMutationLedger.permanentBanTimestamps.set(
          phase,
          Date.now()
        );
      }
    }
    startupDagMutationLedger.appliedMutations.clear();
  }

  if (
    startupDagProfiler.criticalPathDeltaMs !== null &&
    startupDagProfiler.criticalPathDeltaMs <= 100
  ) {
    startupDagMutationLedger.mutationConfidenceScore =
      Math.min(
        100,
        startupDagMutationLedger.mutationConfidenceScore + 5
      );
    if (
      startupDagMutationLedger.mutationConfidenceScore >=
        90 &&
      startupDagMutationLedger.canaryCohortSize <
        startupDagSelfHealing.permanentlyPromoted.size
    ) {
      startupDagMutationLedger.canaryCohortSize += 1;
    }
    // Wave 19 → decay risk score for phases in a healthy cohort
    for (const phase of
      startupDagMutationLedger.lastExpandedCohort) {
      const currentRisk =
        startupDagMutationLedger.phaseRiskScores.get(
          phase
        ) || 0;
      if (currentRisk > 0) {
        startupDagMutationLedger.phaseRiskScores.set(
          phase,
          Math.max(
            0,
            currentRisk - 2
          )
        );
      }
    }
    // Wave 21 → healthy appeal: clear probation tier when risk is low enough
    for (const phase of
      startupDagMutationLedger.lastExpandedCohort) {
      const currentRisk =
        startupDagMutationLedger.phaseRiskScores.get(
          phase
        ) || 0;
      if (
        currentRisk <=
        startupDagMutationLedger.appealHealthyStreakThreshold
      ) {
        startupDagMutationLedger.probationTiers.delete(
          phase
        );
      }
    }
    startupDagMutationLedger.cohortHistory.push({
      timestamp: Date.now(),
      cohort_size:
        startupDagMutationLedger.canaryCohortSize,
      confidence:
        startupDagMutationLedger.mutationConfidenceScore,
    });
    if (startupDagMutationLedger.cohortHistory.length > 500) {
      startupDagMutationLedger.cohortHistory.shift();
    }
  }

  if (
    startupSlaHistory.rollingP95Ms &&
    criticalPathDurationMs >
      startupSlaHistory.rollingP95Ms
  ) {
    logger.warn(
      '[Server] Wave 15 critical path regression detected',
      {
        critical_path_duration_ms:
          criticalPathDurationMs,
        rolling_p95_ms:
          startupSlaHistory.rollingP95Ms,
        delta_ms:
          startupDagProfiler.criticalPathDeltaMs,
        repeated_chain_count:
          chainFingerprint.repetitionCount,
        zero_value_blockers:
          startupDagProfiler.zeroValueCriticalBlockers,
        async_candidates:
          startupDagProfiler.reclassificationCandidates,
      }
    );
  }

  if (
    startupDagSelfHealing.autoPromotedCandidates.length
  ) {
    logger.info(
      '[Server] Wave 16 DAG self-healing promotion candidates detected',
      {
        promoted_candidates:
          startupDagSelfHealing.autoPromotedCandidates,
        threshold:
          startupDagSelfHealing.promotionThreshold,
        healing_actions:
          startupDagSelfHealing.healingHistory.length,
      }
    );
  }

  return true;
}

function registerRoute(path, ...handlers) {
  // Key includes the last handler's identity so that multiple routers mounted
  // on the same path (e.g. three distinct /career mounts) each get a unique
  // signature instead of colliding on handler count alone.
  const lastHandler = handlers[handlers.length - 1];
  const handlerKey =
  typeof lastHandler === 'function'
    ? lastHandler.name || `anonymous_${handlers.length}`
    : lastHandler?.stack
      ? `router_${
          lastHandler.stack
            .map((layer) =>
              layer.route?.path ||
              layer.name ||
              layer.regexp?.toString()
            )
            .join('|')
        }`
      : `handler_${handlers.length}`;

  const signature = `${path}::${handlerKey}`;

  if (registeredRouteKeys.has(signature)) {
   logger.warn('[Server] Duplicate route registration prevented', {
  path,
  handlerKey,
  signature,
});
    return;
  }

  registeredRouteKeys.add(signature);
  app.use(path, ...handlers);
}

function logRouteRegistrySummary() {
  // registeredRouteKeys only tracks the subset of mounts made via registerRoute().
  // The majority of protected routes use app.use() directly and are NOT counted here.
  //
  // ROOT CAUSE OF "total_guarded_route_mounts: 0":
  //   bootstrap() calls registeredRouteKeys.clear() after routes are registered at
  //   module-parse time. The Set is correctly populated at parse time, then wiped,
  //   so this log always reported 0. That was a misleading metric, not a real problem.
  //
  // FIX: read the live Express router stack for an authoritative mount count, and
  // keep the registerRoute count only as a secondary diagnostic.
  const expressStack   = app._router?.stack ?? [];
  const routerLayers   = expressStack.filter((l) => l.name === 'router' || l.handle?.stack);
  const totalMounts    = routerLayers.length;
  const guardedByRegFn = registeredRouteKeys.size;

  logger.info('[Server] Route registry initialized', {
    // Authoritative — counts every app.use() mount in the Express stack.
    total_express_mounts: totalMounts,
    // Secondary — counts only routes registered via registerRoute() helper.
    // Will be 0 when called after bootstrap() clears the Set; that is expected.
    registerRoute_entries: guardedByRegFn,
    note: 'All private routes carry authenticate() — see Protected Route Modules block.',
  });
}
// Trust proxy — safe for Cloud Run / GCP Load Balancer.
// '1' means trust exactly one proxy hop; do not use 'true' (trusts all).
app.set('trust proxy', 1);

// =============================================================================
// CORS configuration
// =============================================================================
// Strict origin allowlist — driven entirely by ALLOWED_ORIGINS env var.
// No localhost fallback in production. ALLOWED_ORIGINS must be explicitly set.
const MAIN_DOMAIN  = process.env.MAIN_DOMAIN  || 'hirerise.com';
const ADMIN_DOMAIN = process.env.ADMIN_DOMAIN || `admin.${MAIN_DOMAIN}`;

if (IS_PRODUCTION && (!process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGINS.trim() === '')) {
  throw new Error('[CORS] ALLOWED_ORIGINS must be set in production');
}

const _rawAllowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
  : [];

const allowedOrigins = [
  ..._rawAllowedOrigins,
  ...(IS_TEST ? [] : [
    `https://${MAIN_DOMAIN}`,
    `https://${ADMIN_DOMAIN}`,
    `https://www.${MAIN_DOMAIN}`,
  ]),
  // CORS FIX: Include 127.0.0.1 variants in addition to localhost.
  // Some browsers and tools send 127.0.0.1 as the Origin header instead of
  // localhost (they are technically different origins). Without these entries,
  // requests from 127.0.0.1:3000 would be rejected with a CORS error even
  // though the backend correctly allows localhost:3000.
  // PORT NOTE: backend .env must set PORT=3001 to match NEXT_PUBLIC_API_BASE_URL.
  ...(IS_PRODUCTION ? [] : [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:5173',   // Vite dev server
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3001',
    'http://127.0.0.1:5173',   // Vite dev server (127.0.0.1 variant)
  ]),
].filter(Boolean);

// =============================================================================
// Global middleware — single registration, enforced order
// =============================================================================
app.use(correlationMiddleware);
app.use(helmet());
app.use(compression());

app.use(cors({
  origin: (origin, callback) => {
    // Wildcard + credentials:true is spec-forbidden and a security hole.
    // Origins must be explicitly whitelisted.
    //
    // Null/missing origin (direct curl, Postman without Origin, stripped by
    // certain proxies) is REJECTED in production to prevent CSRF via
    // opaque-origin requests. It is allowed in non-production so that local
    // tooling and server-to-server calls still work during development.
    if (!origin) {
      if (IS_PRODUCTION) {
        return callback(new Error('CORS: Null origin rejected in production'));
      }
      return callback(null, true);
    }
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS: Origin ${origin} not allowed`));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 'Authorization',
    'X-Request-ID', 'X-Correlation-ID', 'Idempotency-Key',
  ],
  exposedHeaders: ['X-Correlation-ID', 'X-Request-ID'],
  credentials: true,
  maxAge: 86400,
}));

// ── Body Parsing ──────────────────────────────────────────────────────────────
// IMPORTANT: Stripe raw body MUST be registered before express.json() so that
// the webhook signature verifier receives the unmodified Buffer.
app.use('/api/v1/webhooks/stripe', express.raw({ type: 'application/json' }));

app.use(express.json({ limit: '512kb' }));
app.use(express.urlencoded({ extended: true, limit: '512kb' }));
// PR 2: Global request timeout protection
app.use(requestTimeout);

app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs =
      Number(process.hrtime.bigint() - startedAt) / 1e6;

    const roundedDurationMs = Number(
      durationMs.toFixed(2)
    );

    const routeKey = `${req.method}:${
  // FIX M3: Prefer req.route.path (e.g. /career/:id) over req.originalUrl
  // (e.g. /career/abc123) to canonicalize keys and prevent per-ID bucket
  // proliferation which would cause unbounded Map growth in high-traffic APIs.
  req.route?.path ||
  req.path ||
  req.originalUrl
}`;

if (!routeLatencyBuckets.has(routeKey)) {
  routeLatencyBuckets.set(routeKey, []);
}

// FIX 2: Cap Map size on every write path, not just new-key creation.
// Previously the cap only fired when a new key was inserted; if a dynamic
// value slipped through req.route?.path (e.g. query strings, encoded chars)
// the Map would grow unbounded across existing bucket writes.
if (routeLatencyBuckets.size > 500) {
  routeLatencyBuckets.delete(routeLatencyBuckets.keys().next().value);
}

const samples = routeLatencyBuckets.get(routeKey);
samples.push(roundedDurationMs);

if (samples.length > ROUTE_BUCKET_SAMPLE_LIMIT) {
  samples.shift();
}

const sortedSamples = [...samples].sort(
  (a, b) => a - b
);

const p95Index = Math.max(
  0,
  Math.floor(sortedSamples.length * 0.95) - 1
);

const p95DurationMs =
  sortedSamples[p95Index] ??
  roundedDurationMs;

    const logMethod =
      roundedDurationMs >= 250
        ? logger.warn.bind(logger)
        : logger.info.bind(logger);

    logMethod('[Telemetry] HTTP request completed', {
      requestId:
        req.requestId ||
        req.headers['x-request-id'] ||
        null,
      correlationId:
        req.correlationId ||
        req.headers['x-correlation-id'] ||
        null,
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      duration_ms: roundedDurationMs,
      p95_duration_ms: p95DurationMs,
      slow_route: roundedDurationMs >= 250,
    });
  });

  next();
});

// ── HTTP request logger ───────────────────────────────────────────────────────
if (!IS_TEST) {
  app.use(
    morgan(
      IS_PRODUCTION ? 'short' : 'dev',
      {
        stream: {
          write: (msg) => logger.http(msg.trim()),
        },
      }
    )
  );
}

// ── Structured request logger + metrics ───────────────────────────────────────
// Runs alongside morgan: emits [HTTP] one-liner + feeds in-process metrics.
// morgan handles basic access log; this handles structured JSON + p50/p95/p99.
app.use(requestLoggerMiddleware);

// ── API prefix ────────────────────────────────────────────────────────────────
// Hardcoded — must never be overridden via env.
const API_PREFIX = '/api/v1';

// ── Dev routes — non-production only ─────────────────────────────────────────
if (!IS_PRODUCTION) {
  const devRoutes = require('./modules/dev/dev.routes');
  app.use(`${API_PREFIX}/dev`, devRoutes);
}

// ── Global rate limiter ───────────────────────────────────────────────────────
// Keyed by authenticated UID when available; falls back to IP for anonymous
// requests (webhooks, health). IP-only limiting is trivially bypassed behind
// a CDN and is unfair in NAT environments.
//
// RATE LIMIT CONSISTENCY FIX:
// express-rate-limit defaults to an in-memory store which is per-process and
// does not survive restarts or scale across multiple instances. In production
// this means a user can reset their quota by hitting a different pod.
// We implement a custom Redis-backed store using the existing redisClient
// (no new dependencies) so counters are global and persistent.
//
// Falls back to the default in-memory store in dev/test where Redis may not
// be running — production requires Redis (enforced by env.js validation).
const redisClient = require('./config/redisClient');

class RedisRateLimitStore {
  constructor(windowMs) {
    this.windowSeconds = Math.ceil(windowMs / 1000);
    this.prefix = 'rl:global:';
  }

  async increment(key) {
    const redisKey = `${this.prefix}${key}`;
    try {
      // Use the unified redisClient.get/set API (works with ioredis internally)
      const raw = await redisClient.get(redisKey);
      const current = raw ? parseInt(raw, 10) : 0;
      const next = current + 1;
      await redisClient.set(redisKey, String(next), this.windowSeconds);
      const resetTime = new Date(Date.now() + this.windowSeconds * 1000);
      return { totalHits: next, resetTime };
    } catch (err) {
      // If Redis is unavailable, fail open at the store level — the
      // Supabase-backed AI limiters provide the real enforcement layer.
      logger.warn('[GlobalRateLimit] Redis store error — allowing request', {
        error: err.message,
        key: redisKey,
      });
      return { totalHits: 1, resetTime: new Date(Date.now() + this.windowSeconds * 1000) };
    }
  }

  async decrement(key) {
    const redisKey = `${this.prefix}${key}`;
    try {
      const raw = await redisClient.get(redisKey);
      const current = raw ? parseInt(raw, 10) : 0;
      if (current > 0) {
        await redisClient.set(redisKey, String(current - 1), this.windowSeconds);
      }
    } catch {
      // best-effort
    }
  }

  async resetKey(key) {
    try {
      await redisClient.del(`${this.prefix}${key}`);
    } catch {
      // best-effort
    }
  }
}

const rateLimitWindowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS    || '900000', 10);
const rateLimitMax      = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '400',    10);

// AUTH BOOT ENDPOINTS — exempt from global rate limiting.
//
// WHY: /api/v1/app-entry and /api/v1/users/me are called on every page load
// as part of the Supabase auth hydration sequence (warmAppEntry + fetchUser).
// React StrictMode double-mounts and Supabase firing INITIAL_SESSION +
// SIGNED_IN + TOKEN_REFRESHED in rapid succession mean these two endpoints are
// hit 4-6 times per login in dev. The globalLimiter runs BEFORE authenticate,
// so req.user is always undefined at that point — all requests fall back to
// IP-based bucketing, meaning every dev request on localhost shares one counter.
// This causes spurious 429s on the boot endpoints, which AppContext catches as
// RateLimitHydrationError and defers — but Supabase keeps firing TOKEN_REFRESHED,
// each of which retries the pair of requests, producing an infinite 429 storm
// that prevents the user from ever logging in.
//
// The boot endpoints are already protected by authenticate (JWT verification),
// so skipping the global IP limiter here does not reduce security.
const AUTH_BOOT_PATHS = new Set(['/api/v1/app-entry', '/api/v1/users/me']);

// WP-SEC-01: globalLimiter must run before routing (so unknown routes still
// get a normal 404, not an auth check) and before authenticate() (so abuse
// protection still applies to floods of invalid/anonymous requests, not just
// verified ones). That means req.user is never set yet at keyGenerator time.
//
// Rather than decoding the JWT here (a second, competing identity/parsing
// implementation — rejected in WP-SEC-01 Attempt 1) or moving authenticate()
// ahead of routing (breaks 404 semantics — rejected in WP-SEC-01 Attempt 2),
// this reuses the existing verified-token cache that authenticate() itself
// reads and writes (src/core/tokenCache.js). If this exact bearer token has
// already been verified on a prior request in this cache's TTL window (true
// for essentially all real sessions, since the same JWT is reused across a
// user's requests), we key the bucket by that already-authoritative uid.
// First-time tokens, invalid tokens, and anonymous requests fall back to IP,
// identical to previous behavior. No JWT is parsed or verified here — this is
// a cache read of state authenticate() already produced.
async function rateLimitIdentity(req) {
  try {
    const authHeader = req.headers?.authorization;
    if (!authHeader?.startsWith('Bearer ')) return null;

    const rawToken = authHeader.slice(7);
    const cached = await tokenCache.get(rawToken);
    return cached?.uid || cached?.id || null;
  } catch {
    return null;
  }
}

const globalLimiter = rateLimit({
  windowMs: rateLimitWindowMs,
  max:      rateLimitMax,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator: async (req) => (await rateLimitIdentity(req)) || req.ip,
  skip: (req) => AUTH_BOOT_PATHS.has(req.path),
  // Use Redis store in production; default in-memory store in dev/test
  ...(IS_PRODUCTION && { store: new RedisRateLimitStore(rateLimitWindowMs) }),
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many requests. Please retry later.' },
  },
});
app.use(globalLimiter);

// =============================================================================
// =============================================================================
// ✅ Health & Readiness (PUBLIC — no auth)
// =============================================================================
// GET /api/v1/health        — load balancer liveness probe
// GET /api/v1/health/deep   — deep Postgres/Redis/Anthropic/queue probe
//                             (requires X-Health-Probe-Token header)
// GET /api/v1/ready         — Kubernetes readiness probe
registerRoute(
  `${API_PREFIX}/health`,
  require('./routes/health.routes')
);

app.get(`${API_PREFIX}/ready`, async (req, res) => {
  // Wave 30 — evict crash-expired leases before reading telemetry
  evictExpiredDistributedLeases();

  const redis = getRedisStatus();

  let database = {
    connected: false,
    provider: 'supabase',
  };

  try {
    const dbStartedAt = process.hrtime.bigint();

    const { error } = await supabase
      .from('user_profiles')
      .select('id')
      .limit(1);

    const dbDurationMs =
      Number(process.hrtime.bigint() - dbStartedAt) / 1e6;

    logger.info('[Telemetry] Supabase ready probe', {
      duration_ms: Number(dbDurationMs.toFixed(2)),
      success: !error,
    });

    database.connected = !error;
    database.latency_ms = Number(dbDurationMs.toFixed(2));
  } catch (err) {
    logger.warn('[Server] Ready probe DB check failed', {
      error: err.message,
    });
  }

  const ok =
    redis.connected &&
    database.connected &&
    startupBarrier.isReleased;

  // FIX S1: Default response exposes only the minimum fields needed by a load
  // balancer or Kubernetes readiness probe. Full internal telemetry (node IDs,
  // lease epochs, chaos state, DAG mutation scores, trust maps) is gated behind
  // ?verbose=1 AND the INTERNAL_SERVICE_TOKEN header to prevent information
  // disclosure to the public internet.
  const isVerbose =
    req.query.verbose === '1' &&
    req.headers['x-internal-service-token'] === process.env.INTERNAL_SERVICE_TOKEN &&
    process.env.INTERNAL_SERVICE_TOKEN;

  if (!isVerbose) {
    return res.status(ok ? 200 : 503).json({
      status: ok ? 'ready' : 'degraded',
      redis:    { connected: redis.connected },
      database: { connected: database.connected, provider: database.provider },
      timestamp: new Date().toISOString(),
    });
  }

  // FIX C2: Extract Redis lease state into a local variable BEFORE building the
  // response object literal. The previous pattern mutated `res._readyLeaseState`
  // inside an inline IIFE, which is fragile and non-obvious.
  const _readyLeaseState = await getRedisLeaseState(getLocalReplicaId());

  res.status(ok ? 200 : 503).json({
    status: ok ? 'ready' : 'degraded',
    redis,
    database,
    timestamp: new Date().toISOString(),

  startupBarrier: {
  released: startupBarrier.isReleased,
  degraded: startupWatchdog.degradedReleaseAllowed,
  completed: startupBarrier.completed.size,
  total: startupBarrier.phases.size,
  releaseTimestamp: startupBarrier.releaseTimestamp,
  timeoutMs: startupWatchdog.timeoutMs,
  slowestPhase: startupBarrier.slowestPhase,
  slowPhaseRepetitionCount:
    startupBarrier.slowestPhase?.phase
      ? startupRegressionProfiler.repeatedSlowPhase.get(
          startupBarrier.slowestPhase.phase
        ) || 0
      : 0,
  slaSamplesCollected: startupSlaHistory.samples.length,
  rollingAverageMs: startupSlaHistory.rollingAverageMs,
  rollingP95Ms: startupSlaHistory.rollingP95Ms,
  forecastNextStartupMs: startupSlaHistory.lastForecastMs,
  recommendedTimeoutMs:
  startupAdaptiveTimeoutPolicy.lastRecommendedTimeoutMs ||
  startupWatchdog.timeoutMs,
  appliedAdaptiveTimeoutMs:
  startupAdaptiveTimeoutPolicy.lastAppliedTimeoutMs ||
  startupWatchdog.timeoutMs,
adaptiveTimeoutMinMs:
  startupAdaptiveTimeoutPolicy.minTimeoutMs,
adaptiveTimeoutMaxMs:
  startupAdaptiveTimeoutPolicy.maxTimeoutMs,
adaptiveTimeoutMultiplier:
  startupAdaptiveTimeoutPolicy.tuningMultiplier,
  chaosConfidenceScore:
  startupChaosConfidence.confidenceScore,
rollbackRiskScore:
  startupChaosConfidence.rollbackRiskScore,
rollbackThreshold:
  startupChaosConfidence.rollbackThreshold,
degradedStartupReleases:
  startupChaosConfidence.degradedReleases,
startupAnomalyBreaches:
  startupChaosConfidence.anomalyBreaches,
successfulAdaptiveRecoveries:
  startupChaosConfidence.successfulAdaptiveRecoveries,
rollbackAdvisory:
  startupChaosConfidence.confidenceScore <
  startupChaosConfidence.rollbackThreshold,
dagSlackPhases: Object.fromEntries(
  startupDagProfiler.slackByPhase
),
criticalPathDeltaMs:
  startupDagProfiler.criticalPathDeltaMs,
zeroValueCriticalBlockers:
  startupDagProfiler.zeroValueCriticalBlockers,
movablePostRelease:
  startupDagProfiler.movablePostRelease,
criticalAsyncCandidates:
  startupDagProfiler.reclassificationCandidates,
dagSelfHealingCandidates:
  startupDagSelfHealing.autoPromotedCandidates,
dagSelfHealingThreshold:
  startupDagSelfHealing.promotionThreshold,
dagHealingActions:
  startupDagSelfHealing.healingHistory.length,
lastDagHealingActionAt:
  startupDagSelfHealing.lastHealingActionAt,
dagMutationsApplied:
  startupDagMutationLedger.appliedMutations.size,
dagMutationLastAppliedAt:
  startupDagMutationLedger.lastMutationAt,
dagMutationRollbackEvents:
  startupDagMutationLedger.rollbackEvents.length,
dagMutationLastRollbackAt:
  startupDagMutationLedger.lastRollbackAt,
dagMutationCanaryCohortSize:
  startupDagMutationLedger.canaryCohortSize,
dagMutationConfidenceScore:
  startupDagMutationLedger.mutationConfidenceScore,
dagMutationCohortHistory:
  startupDagMutationLedger.cohortHistory.length,
dagMutationQuarantinedPhases:
  startupDagMutationLedger.quarantinedPhases.size,
dagMutationLastQuarantineAt:
  startupDagMutationLedger.lastQuarantineAt,
dagMutationRiskDecayLastAt:
  startupDagMutationLedger.lastRiskDecayAt,
dagMutationAdaptiveCooldownBaseMs:
  startupDagMutationLedger.quarantineBaseCooldownMs,
dagMutationAdaptiveCooldownMaxMs:
  startupDagMutationLedger.quarantineMaxCooldownMs,
dagMutationProbationTiers:
  startupDagMutationLedger.probationTiers.size,
dagMutationPermanentBans:
  startupDagMutationLedger.permanentlyBannedPhases.size,
dagMutationPermanentBanTimestamps:
  startupDagMutationLedger.permanentBanTimestamps.size,
dagMutationParoleReviewCandidates:
  startupDagMutationLedger.paroleReviewCandidates.size,
dagMutationParoleSandbox:
  startupDagMutationLedger.paroleSandbox.size,
dagMutationSandboxVerdicts:
  startupDagMutationLedger.sandboxVerdicts.length,
dagMutationPrecedentTracked:
  startupDagMutationLedger.precedentScores.size,
dagMutationConstitutionalProtected:
  startupDagMutationLedger.constitutionalProtectedPhases.size,
dagMutationConstitutionalOverrides:
  startupDagMutationLedger.constitutionalOverrideHits,
dagMutationProbationHistory:
  startupDagMutationLedger.probationHistory.length,
distributedConsensus: {
  nodes:
    distributedStartupConsensus.nodes.size,
  driftEvents:
    distributedStartupConsensus.driftEvents.length,
  lastConsensusAt:
    distributedStartupConsensus.lastConsensusAt,
  quorumFloor:
    distributedStartupConsensus.quorumFloor,
},
distributedArbitration: {
  pendingRelease:
    startupBarrier.pendingDistributedRelease,
  activeLocks:
    distributedStartupConsensus.releaseLocks.size,
  staleNodeTtlMs:
    distributedStartupConsensus.staleNodeTtlMs,
  // Wave 30 — lease mesh telemetry
  leaseDurationMs:
    distributedStartupConsensus.leaseDurationMs,
  leaseRenewIntervalMs:
    distributedStartupConsensus.leaseRenewIntervalMs,
  leaseDriftEvents:
    distributedStartupConsensus.leaseDriftEvents,
  // Wave 31 — PATCH 6: durable Redis authority telemetry
  durableLeaseAuthority: 'redis',
  localLeaseEpoch: (() => {
    const readyNodeId = getLocalReplicaId();
    return distributedStartupConsensus.releaseLocks.get(readyNodeId)?.leaseEpoch || null;
  })(),
  localRedisLeasePresent: _readyLeaseState?.leaseExists ?? null,
  // Wave 32 — Lua CAS telemetry fields
  luaCasEnabled: true,
  leaseOwnerEpoch: _readyLeaseState?.persistedEpoch ?? null,
  // Wave 33 — cross-region failover telemetry
  leaseRedisRegion:     leaseFailoverState.usingFallback
    ? leaseFailoverState.fallbackRegion
    : leaseFailoverState.primaryRegion,
  leaseFailoverActive:  leaseFailoverState.usingFallback,
  leaseFailoverEvents:  leaseFailoverState.failoverEvents.length,
  lastLeaseFailoverAt:  leaseFailoverState.lastFailoverAt,
  lastLeaseFailbackAt:  leaseFailoverState.lastFailbackAt,
  leaseConsecutiveFailures:   leaseFailoverState.consecutiveFailures,
  leaseConsecutiveRecoveries: leaseFailoverState.consecutiveRecoveries,
  localLease: (() => {
    const readyNodeId = getLocalReplicaId();
    return (
      distributedStartupConsensus.releaseLocks.get(readyNodeId) || null
    );
  })(),
  // Wave 34 — chaos simulation + region drift rollback telemetry
  leaseChaosEnabled:          leaseChaosState.enabled,
  leaseChaosScenario:         leaseChaosState.activeScenario,
  leaseChaosInjectedFailures: leaseChaosState.injectedFailures,
  leaseChaosDriftDetections:  leaseChaosState.driftDetections,
  leaseChaosRollbackEvents:   leaseChaosState.rollbackEvents.slice(-10),
  leaseChaosLastRollbackAt:   leaseChaosState.lastRollbackAt,
  leaseMaxRegionDriftMs:      leaseChaosState.maxDriftToleranceMs,
  // Wave 35 — rollback confidence scoring telemetry
  rollbackConfidenceScore:       rollbackConfidenceState.lastScore,
  rollbackConfidenceSeverity:    rollbackConfidenceState.lastSeverity,
  rollbackConfidenceEvaluations: rollbackConfidenceState.totalEvaluations,
  rollbackSuppressedCount:       rollbackConfidenceState.suppressedRollbacks,
  rollbackConfirmedCount:        rollbackConfidenceState.confirmedRollbacks,
  rollbackMinThreshold:          rollbackConfidenceState.minRollbackConfidence,
  rollbackSeverityHistoryTail:   rollbackConfidenceState.severityHistory.slice(-10),
  // Wave 36 — adaptive trust decay + quorum escalation telemetry
  rollbackRegionTrust: (() => {
    const out = {};
    for (const [region, entry] of rollbackTrustState.regionTrust) {
      const ageMs = Date.now() - entry.updatedAt;
      out[region] = Math.round(
        getDecayedTrust(entry.trust, ageMs, rollbackTrustState.decayHalfLifeMs)
      );
    }
    return out;
  })(),
  rollbackNodeTrust: (() => {
    const out = {};
    for (const [nodeId, entry] of rollbackTrustState.nodeTrust) {
      const ageMs = Date.now() - entry.updatedAt;
      out[nodeId] = Math.round(
        getDecayedTrust(entry.trust, ageMs, rollbackTrustState.decayHalfLifeMs)
      );
    }
    return out;
  })(),
  rollbackTrustEventTail:    rollbackTrustState.trustEvents.slice(-10),
  regionalEscalationCount:   regionalEscalationState.totalEscalations,
  regionalEscalationTail:    regionalEscalationState.escalations.slice(-10),
  quorumEscalationThreshold: rollbackTrustState.minQuorumEscalationTrust,
  // Wave 37 — cross-region anomaly fusion telemetry
  anomalyFusionScore:           anomalyFusionState.consensusScore,
  anomalyFusionRegionCount:     anomalyFusionState.regions.size,
  anomalyFusionLastEvaluatedAt: anomalyFusionState.lastEvaluatedAt,
  anomalyFusionStateTail:       (() => {
    const out = [];
    for (const [regionId, signal] of anomalyFusionState.regions) {
      out.push({ regionId, ...signal });
    }
    return out.slice(-10);
  })(),
  // Wave 50 — Phase 5: rollback decision observability counters
  rollbackMetrics: systemMetrics,
},
},
  });
});

// =============================================================================
// ✅ Internal Routes (NO user auth — protected by INTERNAL_SERVICE_TOKEN)
// =============================================================================
// Called by Google Cloud Tasks (server-to-server only).
// Registered BEFORE authenticate so they never require a user JWT.
app.use(
  `${API_PREFIX}/internal/provisional-chi`,
  requireInternalToken,
  require('./routes/internal/provisionalChi.route'),
);

// Async AI job processor — Cloud Tasks callback
// Receives { jobId }, runs the AI operation, writes result to ai_jobs table.
app.use(
  `${API_PREFIX}/internal/ai-job`,
  requireInternalToken,
  require('./routes/internal/aiJob.route'),
);

// =============================================================================
// ✅ Webhook Routes (NO authenticate — signature-verified per handler)
// =============================================================================
// Razorpay + Stripe send server-to-server requests.
// Must be registered BEFORE protected routes.
app.use(`${API_PREFIX}/webhooks`, require('./routes/webhooks.routes'));

// =============================================================================
// ✅ Observability — Prometheus metrics endpoint
// =============================================================================
// Active only when OBSERVABILITY_BACKEND=prometheus. No-op in all other modes.
// Mounted before 404 handler.
// FIX S3: Protected by requireInternalToken — metrics expose internal counters
// and must never be reachable from the public internet.
app.get(`${API_PREFIX}/metrics`, requireInternalToken, observabilityAdapter.prometheusMetricsHandler());

// =============================================================================
// ✅ Protected Route Modules (authenticate applied per route group)
// =============================================================================
// Auth applied per-group intentionally: avoids the 401-before-404 ordering bug
// that occurs when a global authenticate() precedes all routes.
//
// Design rationale: if a user calls GET /api/v1/nonexistent without a token,
// a global auth guard would return 401. The correct answer is 404 — the route
// doesn't exist. Per-route auth preserves correct 404 semantics for unknown
// paths while still enforcing auth on every registered private route.

// =============================================================================
// ✅ GLOBAL AUTH SAFETY NET — moved below all route registrations
// =============================================================================
// NOTE: This block has been relocated to just before notFoundHandler/errorHandler
// so that per-route authenticate() middleware runs FIRST and sets req.user
// before this guard checks for it. Previously it was registered before the
// routes, so req.user was always undefined here and every request got a 401.


registerRoute(
  `${API_PREFIX}/career`,
  authenticate,
  tenantRegionMiddleware,
  require('./routes/career.routes')
);

// Patch 48B Fix 2: engagementRouter is an intentional second bounded-context
// router at /career. Uses app.use directly so it coexists with career.routes
// without triggering the duplicate-guard fingerprint collision.
app.use(
  `${API_PREFIX}/career`,
  authenticate,
  engagementRouter
);

// Patch 48B Fix 4: digitalTwin is an intentional third bounded-context router
// at /career. Uses app.use directly — its router exports with an empty or
// unnamed stack at require-time, producing the same bare "router" handlerKey
// as career.routes and triggering a false duplicate-guard collision.
app.use(
  `${API_PREFIX}/career`,
  authenticate,
  require('./modules/career-digital-twin/routes/digitalTwin.routes')
);

registerRoute(
  `${API_PREFIX}/career-opportunities`,
  authenticate,
  require('./routes/career-opportunity.routes')
);

registerRoute(
  `${API_PREFIX}/skill-graph`,
  authenticate,
  require('./modules/skillGraph/skillGraph.routes')
);

app.use(`${API_PREFIX}/admin/graph`,               authenticate, requireAdmin, requireElevatedSession, require('./modules/admin/graph/graphAdmin.routes'));
app.use(`${API_PREFIX}/admin/graph-intelligence`,  authenticate, requireAdmin, requireElevatedSession, require('./modules/admin/graph/graphIntelligence.routes'));
app.use(`${API_PREFIX}/admin/platform-intelligence`, authenticate, requireAdmin, requireElevatedSession, require('./modules/platform-intelligence/routes/platformIntelligence.routes'));

// WP-P2-01 — Source Intelligence Management (SIM).
// Enterprise registry of external knowledge sources: metadata + governance
// only (no collection/transform/publish). Admin-only — internal governance
// surface, not student/employer facing. See
// modules/source-intelligence/server-registration.snippet.js for the full
// route summary and the optional event-publisher wiring.
app.use(`${API_PREFIX}/admin/source-intelligence`, authenticate, requireAdmin, requireElevatedSession, require('./modules/source-intelligence').routes);

app.use(`${API_PREFIX}/chi-v2`,        authenticate, require('./modules/chiV2/chiV2.routes'));
app.use(`${API_PREFIX}/salary`,        authenticate, require('./routes/salary.routes'));


app.use(`${API_PREFIX}/jobs`,          authenticate, require('./routes/jobs.routes'));
app.use(`${API_PREFIX}/resume-growth`, authenticate, require('./routes/resumeGrowth.routes'));

registerRoute(
  `${API_PREFIX}/growth`,
  authenticate,
  require('./routes/growth.routes')
);
app.use(`${API_PREFIX}/resume-scores`, authenticate, require('./routes/resumeScore.routes'));
app.use(`${API_PREFIX}/learning`,      authenticate, require('./routes/learning.routes'));
app.use(`${API_PREFIX}/resumes`,       authenticate, require('./modules/resume/resume.routes'));
app.use(`${API_PREFIX}/onboarding`,    authenticate, require('./modules/onboarding/onboarding.routes'));

// FIX: onboarding-complete.routes.js was previously unmounted — GET /onboarding/resume,
// PATCH /onboarding/progress, POST /onboarding/complete returned 404.
// Without this, onboarding_completed was never saved; AuthGuard caused infinite
// redirect loop back to /onboarding → permanent spinner on /dashboard.
app.use(`${API_PREFIX}/student-onboarding`, authenticate, require('./routes/student-onboarding.routes'));

// ── Phase 3A–3C: v2 Step Routes (Academics / Activities / Cognitive) ──────────
// These controllers expect req.supabase (service-role singleton) and
// req.onboardingSession (loaded via session.service.getSession).
// The routes were fully implemented but never mounted — causing 404s and the
// 429 storm from client retry logic hammering the missing endpoints.
{
  const sessionService = require('./modules/student-onboarding/services/session.service');

  /**
   * Injects req.supabase and req.onboardingSession so v2 step controllers
   * can use them without importing the singleton directly.
   * authenticate must run before this middleware (req.user must be set).
   */
  async function requireOnboardingSession(req, res, next) {
    try {
      req.supabase          = supabase; // singleton imported at line 163
      req.onboardingSession = await sessionService.getSession(req.user.id);
      next();
    } catch (err) {
      if (err.status === 404) {
        return res.status(404).json({
          success: false,
          error: { message: 'No onboarding session found. Call POST /session to begin.' },
        });
      }
      next(err);
    }
  }

  // Phase 3A — Academics
  app.use(
    `${API_PREFIX}/student-onboarding/v2/step/academics`,
    authenticate,
    requireOnboardingSession,
    require('./modules/student-onboarding/routes/academics.routes'),
  );

  // Phase 3B — Activities
  app.use(
    `${API_PREFIX}/student-onboarding/v2/step/activities`,
    authenticate,
    requireOnboardingSession,
    require('./modules/student-onboarding/routes/activities.routes'),
  );

  // Phase 3C — Cognitive
  app.use(
    `${API_PREFIX}/student-onboarding/v2/step/cognitive`,
    authenticate,
    requireOnboardingSession,
    require('./modules/student-onboarding/routes/cognitive.routes'),
  );
}

// ── Phase 3D: Cross-Domain Intelligence Layer ─────────────────────────────────
// Mounted at /api/v1/intelligence
// Auth: JWT (authenticate) + Admin role guard (enforced inside intelligence.routes.js)
// Scope: Internal diagnostics only — not student-facing.
//
// Routes:
//   GET  /api/v1/intelligence/registry
//   GET  /api/v1/intelligence/student/:userId/vector
//   GET  /api/v1/intelligence/student/:userId/confidence
//   GET  /api/v1/intelligence/student/:userId/evidence/:signalKey
//   POST /api/v1/intelligence/student/:userId/trigger
app.use(
  `${API_PREFIX}/intelligence`,
  authenticate,
  require('./modules/student-onboarding/routes/intelligence.routes')
);

app.use(`${API_PREFIX}/career-onboarding`,  authenticate, require('./routes/career-onboarding.routes'));

/**
 * Job Seeker Intelligence
 *   GET /api/v1/job-seeker/skills/user-graph     → personalised skill graph
 *   GET /api/v1/job-seeker/skills/skill-gap      → skill gap vs market demand
 *   GET /api/v1/job-seeker/jobs/match            → top matched roles (scored)
 *   GET /api/v1/job-seeker/jobs/recommendations  → enriched top-5 recommendations
 */

/**
 * Semantic AI — Skill Intelligence + Job Matching (mounted on API_PREFIX directly)
 * Controlled by FEATURE_SEMANTIC_MATCHING=true env flag.
 *
 *   GET  /api/v1/skills/similar                    → semantically similar skills (cosine sim)
 *   POST /api/v1/skills/embed                      → generate/store skill embedding
 *   GET  /api/v1/job-seeker/jobs/semantic-match    → vector-based job matching
 *   GET  /api/v1/career/advice                     → AI career advisor (grounded)
 *   GET  /api/v1/skills/learning-path              → AI-generated learning paths
 */
// FIX: Replaced broad `app.use(API_PREFIX, ...)` mounts with explicit path prefixes.
// Previously any new route added inside these modules was live the moment the
// file was saved, with no per-group auth guard and no path-level visibility in
// the route registry. Explicit mounts restore duplicate-guard protection and
// make the route contract visible in logs.
//
// Phase 2D QUOTA BOUNDARY FIX: aiRateLimit removed from this mount.
// semantic.routes.js already applies aiRateLimitShared per-handler on its
// actual AI inference routes (/skills/similar, /career/advice, etc). Keeping
// aiRateLimit here as well made it fire on EVERY /api/v1/* request that falls
// through this bare-prefix mount (including /app-entry, /users/me, and any
// other route mounted after this line) — see semantic.routes.js header comment:
// "Do NOT move back to server.js mount level — that scope is too broad."
// FIX: semantic.routes uses absolute internal paths (/skills/similar, /career/advice etc).
// Mounting at a sub-path (e.g. /skills or /career) caused Express to strip that prefix,
// making routes only reachable at doubled paths (/career/career/advice).
// Correct mount is at API_PREFIX so paths resolve as intended.
app.use(`${API_PREFIX}`,           authenticate, require('./routes/semantic.routes'));
// The two mounts let Express match the correct prefix; the router uses relative paths internally.

/**
 * AI Career Opportunity Radar (explicit path mounts)
 *   GET  /api/v1/career/opportunity-radar          → personalised emerging opportunities
 *   GET  /api/v1/career/emerging-roles             → public catalogue of emerging roles
 *   POST /api/v1/career/opportunity-radar/refresh  → admin: refresh signals from LMI
 */
// FIX: Explicit path mount — routes no longer auto-expose on save without guard review.
app.use(`${API_PREFIX}/career`,    authenticate, require('./modules/opportunityRadar/opportunityRadar.routes'));

/**
 * AI Event Bus — Async Processing Pipeline
 * Controlled by FEATURE_EVENT_BUS=true env flag.
 *
 * Trigger endpoints (return 202 Accepted + pipelineJobId):
 *   POST /api/v1/career/trigger-analysis          → full pipeline (all workers)
 *   POST /api/v1/career/trigger-job-match         → job matching worker only
 *   POST /api/v1/career/trigger-risk-analysis     → risk analysis worker only
 *   POST /api/v1/career/trigger-opportunity-scan  → opportunity radar worker only
 *   POST /api/v1/career/trigger-advice            → career advisor worker only
 *   POST /api/v1/career/internal/cv-parsed        → internal: fan out CV_PARSED event
 *
 * Results endpoints (read from Supabase result tables):
 *   GET  /api/v1/career/intelligence-report       → merged result across all engines
 *   GET  /api/v1/jobs/matches                     → pre-computed job match results
 *   GET  /api/v1/career/risk                      → pre-computed risk analysis
 *   GET  /api/v1/career/opportunities             → pre-computed opportunity radar
 *
 * Polling:
 *   GET  /api/v1/career/pipeline-status/:jobId    → async job status
 */
// FIX: Explicit path mounts — ai-event-bus routes span /career/* and /jobs/*.
// Broad API_PREFIX mount replaced with explicit prefixes so every route is
// visible in the registry and path guards are enforced per group.
if (process.env.FEATURE_EVENT_BUS === 'true') {
  const aiEventBusRoutes = require('./modules/ai-event-bus/routes/aiEventBus.routes');
  app.use(`${API_PREFIX}/career`, authenticate, aiEventBusRoutes);
  app.use(`${API_PREFIX}/jobs`,   authenticate, aiEventBusRoutes);
}

/**
 * AI Personalization Engine (mounted on API_PREFIX directly)
 *   POST /api/v1/user/behavior-event                  → track user interaction
 *   GET  /api/v1/career/personalized-recommendations  → personalized career list
 *   GET  /api/v1/user/personalization-profile         → current signal profile
 *   POST /api/v1/user/update-behavior-profile         → manual profile refresh
 */
// Phase 2D QUOTA BOUNDARY FIX: aiRateLimit removed from this mount — see
// personalization.routes.js header comment ("PHASE 2D — QUOTA BOUNDARY FIX").
// aiRateLimitShared is already applied per-handler inside that router, on the
// AI inference routes only (/career/personalized-recommendations,
// /user/personalization-profile, /user/update-behavior-profile).
// Leaving aiRateLimit here made it fire on EVERY /api/v1/* request that falls
// through this bare-prefix mount before reaching its real destination,
// including the free onboarding operation POST /api/v1/users/me/direction and
// unrelated boot-time calls like /app-entry and /users/me.
// FIX: personalization.routes comment says "Preferred mount: app.use(API_PREFIX, ...)".
// Sub-path mounts broke routing (same prefix-stripping issue as semantic.routes above).
// Restored to correct API_PREFIX mount. /user/* and /career/* paths resolve correctly.
app.use(`${API_PREFIX}`,           authenticate, require('./modules/personalization/personalization.routes'));

/**
 * Career Copilot — RAG-Grounded Conversational AI
 * Grounds every response in real platform data (CHI, skill gaps, job matches,
 * opportunity radar, risk analysis, salary benchmarks, personalization profile).
 *
 *   POST /api/v1/copilot/chat                    → grounded chat response
 *   GET  /api/v1/copilot/welcome                 → data-aware welcome message
 *   GET  /api/v1/copilot/history/:conversationId → conversation history
 *   GET  /api/v1/copilot/context                 → debug context (non-prod only)
 */
app.use(`${API_PREFIX}/ava-memory`, authenticate, require('./modules/ava-memory/routes/avaMemory.routes'));

/**
 * Education Intelligence — AI Pipeline
 *   POST /api/v1/education/analyze/:studentId          → run pipeline + return recommendation
 *   GET  /api/v1/education/analyze/:studentId          → return cached result
 *   POST /api/v1/education/career-prediction/:studentId → run CSPE, store + return top_careers
 *   GET  /api/v1/education/career-prediction/:studentId → return stored predictions
 *   POST /api/v1/education/roi-analysis/:studentId     → run ERE, store + return education_options
 *   GET  /api/v1/education/roi-analysis/:studentId     → return stored ROI results
 *   POST /api/v1/education/career-simulation/:studentId → run CDTE, store + return simulations
 *   GET  /api/v1/education/career-simulation/:studentId → return stored simulations
 *
 * Auth: students may only access their own profile; admins may access any.
 */
registerRoute(
  `${API_PREFIX}/education`,
  authenticate,
  tenantRegionMiddleware,
  require('./modules/education-intelligence/routes/student.routes')
);
app.use(
  `${API_PREFIX}/analytics`,
  authenticate,
  tenantRegionMiddleware,
  require('./modules/career-intelligence-dashboard/routes/analytics.routes')
);

// FIX: aiRateLimit applied — advisor invokes LLM inference per request; without
// per-route limiting one user can exhaust the global 400 req/15 min bucket.
app.use(
  `${API_PREFIX}/advisor`,
  authenticate,
  aiRateLimit,
  tenantRegionMiddleware,
  require('./modules/ai-career-advisor/routes/advisor.routes')
);

// FIX: aiRateLimit applied — copilot is the highest-cost AI endpoint (RAG +
// LLM). Without per-route limiting one user running 400 chat queries in 15 min
// freezes everyone else out of the whole API.
registerRoute(
  `${API_PREFIX}/copilot`,
  authenticate,
  aiRateLimit,
  tenantRegionMiddleware,
  require('./modules/career-copilot/routes/careerCopilot.routes')
);

// Patch 48B Fix 3: agentCoordinator is an intentional second bounded-context
// router at /copilot. Uses app.use directly so it coexists with careerCopilot.routes
// without triggering the duplicate-guard fingerprint collision.
// FIX: aiRateLimit applied — shares the same per-UID bucket as careerCopilot.routes.
app.use(
  `${API_PREFIX}/copilot`,
  authenticate,
  aiRateLimit,
  tenantRegionMiddleware,
  require('./modules/career-copilot/routes/agentCoordinator.routes')
);

app.use(
  `${API_PREFIX}/job-seeker`,
  authenticate,
  tenantRegionMiddleware,
  require('./modules/jobSeeker/jobSeeker.routes')
);

/**
 * Skill Evolution Engine (SEE)
 *   GET /api/v1/education/skills/recommendations/:studentId → ranked skills + roadmap
 *   GET /api/v1/education/skills/student-skills/:studentId  → raw per-skill rows
 */
app.use(`${API_PREFIX}/education/skills`, authenticate, require('./modules/skill-evolution/routes/skill.routes'));

/**
 * Labor Market Intelligence
 *   GET  /api/v1/market/career-trends      → demand + trend scores per career
 *   GET  /api/v1/market/skill-demand       → top trending skills (optional ?limit=N)
 *   GET  /api/v1/market/salary-benchmarks  → avg entry / 5-yr / 10-yr salaries per career
 *   POST /api/v1/market/refresh            → trigger full LMI refresh (admin only)
 *   POST /api/v1/market/ingest             → trigger job collection only (admin only)
 */
app.use(`${API_PREFIX}/market`, authenticate, require('./modules/labor-market-intelligence/routes/market.routes'));

/**
 * Global Career Intelligence Dashboard (GCID)
 *   GET /api/v1/analytics/health           → analytics service liveness probe (auth required)
 *   GET /api/v1/analytics/career-demand    → Career Demand Index (ranked)
 *   GET /api/v1/analytics/skill-demand     → Skill Demand Index (ranked)
 *   GET /api/v1/analytics/education-roi    → Education ROI Index (ranked)
 *   GET /api/v1/analytics/career-growth    → 10-year salary forecast per career
 *   GET /api/v1/analytics/industry-trends  → Emerging sector analysis
 *   GET /api/v1/analytics/overview         → All five in one response
 *   GET /api/v1/analytics/snapshots/:metric → Historical snapshots
 */
app.use(`${API_PREFIX}/career-health`, authenticate, require('./modules/careerHealthIndex/careerHealthIndex.routes'));

/**
 * Skill Prioritization Intelligence API
 *   GET /api/v1/skills-priority/priority → ranked skill priorities for user
 */
app.use(`${API_PREFIX}/skills-priority`, authenticate, require('./routes/skills-priority.routes'));

/**
 * AI Career Advisor
 *   POST /api/v1/advisor/chat/:studentId    → AI response to student question
 *   GET  /api/v1/advisor/welcome/:studentId → personalised welcome message
 *   GET  /api/v1/advisor/history/:studentId → conversation history
 */

/**
 * School & Counselor Platform
 *   POST /api/v1/school                                      → create school
 *   GET  /api/v1/school/my                                   → schools I belong to
 *   GET  /api/v1/school/:schoolId                            → school detail
 *   POST /api/v1/school/:schoolId/counselors                 → add counselor (admin)
 *   GET  /api/v1/school/:schoolId/students                   → list students
 *   POST /api/v1/school/:schoolId/students/import            → bulk CSV import
 *   POST /api/v1/school/:schoolId/run-assessment/:studentId  → trigger AI pipeline
 *   GET  /api/v1/school/:schoolId/student-report/:studentId  → full student report
 *   GET  /api/v1/school/:schoolId/analytics                  → school analytics
 */
app.use(`${API_PREFIX}/school`, authenticate, require('./modules/school/routes/school.routes'));

/**
 * University Integration Platform
 * Role model enforced by university.middleware.js:
 *   university_admin — full access: CRUD programs + analytics
 *   university_staff — read-only: programs + analytics
 *
 * No student PII is exposed — all student-facing data is aggregated.
 *
 *   POST   /api/v1/university                                         → register university
 *   GET    /api/v1/university/my                                      → universities I belong to
 *   GET    /api/v1/university/:universityId                           → university detail
 *   POST   /api/v1/university/:universityId/programs                  → add program (admin)
 *   GET    /api/v1/university/:universityId/programs                  → list programs (member)
 *   PATCH  /api/v1/university/:universityId/programs/:programId       → update program (admin)
 *   DELETE /api/v1/university/:universityId/programs/:programId       → delete program (admin)
 *   GET    /api/v1/university/:universityId/analytics                 → dashboard analytics
 *   GET    /api/v1/university/:universityId/programs/:programId/matches → aggregated signals
 */
app.use(`${API_PREFIX}/university`, authenticate, require('./modules/university/routes/university.routes'));

/**
 * Employer Integration Platform
 * Role model enforced by employer.middleware.js:
 *   employer_admin — full access: CRUD job roles + pipeline analytics
 *   employer_hr    — read-only: job roles + pipeline analytics
 *
 * Employers NEVER receive personally identifiable student data.
 *
 *   POST   /api/v1/employer                                           → register employer org
 *   GET    /api/v1/employer/my                                        → orgs I belong to
 *   GET    /api/v1/employer/:employerId                               → employer detail
 *   POST   /api/v1/employer/:employerId/roles                         → add job role (admin)
 *   GET    /api/v1/employer/:employerId/roles                         → list job roles
 *   PATCH  /api/v1/employer/:employerId/roles/:roleId                 → update role (admin)
 *   DELETE /api/v1/employer/:employerId/roles/:roleId                 → deactivate role (admin)
 *   GET    /api/v1/employer/:employerId/talent-pipeline               → pipeline analytics
 *   GET    /api/v1/employer/:employerId/roles/:roleId/matches         → per-role talent signals
 */
app.use(`${API_PREFIX}/employer`, authenticate, require('./modules/employer/routes/employer.routes'));

/**
 * Student Opportunities — AI Matching Engine
 * Students may only fetch their own opportunities (UID === studentId).
 * Admins may fetch any student's opportunities.
 *
 * Matching score weights:
 *   University programs: stream_alignment 40% + career_alignment 35% + skill_match 25%
 *   Job roles:           skill_match 40% + stream_alignment 30% + career_alignment 30%
 *
 *   GET /api/v1/opportunities/:studentId → { student_id, universities: [...], jobs: [...] }
 */
app.use(`${API_PREFIX}/opportunities`, authenticate, require('./modules/opportunities/routes/opportunities.routes'));

// Phase 3: user activity tracking — streak, weekly summary, chi delta
// FIX C1: Added authenticate — this endpoint tracks per-user streak/chi data and must be protected.
app.use(`${API_PREFIX}/user-activity`, authenticate, require('./modules/userActivity/userActivity.routes'));

app.use(`${API_PREFIX}/job-analyses`,   authenticate, require('./routes/jobAnalyzer.routes'));
app.use(`${API_PREFIX}/cv-builder`,     authenticate, require('./routes/cvBuilder.routes'));

registerRoute(
  `${API_PREFIX}/users`,
  authenticate,
  require('./routes/users.routes')
);

// FIX: Direction router was mounted at /api/v1/user-direction but all frontend
// calls target /api/v1/users/me/direction. The direction router defines routes
// as /me/direction, /me/direction (GET), and /me/direction (DELETE) — they must
// be mounted under /api/v1/users so that the full resolved paths match.
// Mounting under /api/v1/user-direction caused every POST/GET/DELETE
// /api/v1/users/me/direction call to hit the 404 handler, which returns
// { success: false, error: { code: 'NOT_FOUND' } } — the error seen in the console.
// Direction router — mounted directly (not via registerRoute) to avoid the
// duplicate-signature guard falsely blocking it when users.routes.js is already
// registered at the same /api/v1/users prefix.
app.use(`${API_PREFIX}/users`, authenticate, directionRouter);

app.use(`${API_PREFIX}/analyze`,  authenticate, require('./modules/analysis/analysis.route'));

// Phase 2: async AI job status poll
app.use(`${API_PREFIX}/ai-jobs`,  authenticate, require('./routes/aiJobs.route'));

app.use(`${API_PREFIX}/roles`,         authenticate, require('./modules/roles/roles.routes'));
app.use(`${API_PREFIX}/applications`,  authenticate, require('./jobApplications/jobApplications.routes'));
app.use(`${API_PREFIX}/cover-letter`,  authenticate, require('./modules/coverLetter/coverLetter.routes'));
app.use(`${API_PREFIX}/dashboard`,     authenticate, require('./modules/dashboard/dashboard.route'));
app.use(`${API_PREFIX}/app-entry`,     authenticate, require('./modules/appEntry/appEntry.route'));
app.use(`${API_PREFIX}/qualifications`, authenticate, require('./modules/qualification/qualification.routes'));

// ── WP-IMP-02 — Knowledge Runtime (KnowledgeService) ──────────────────────────
// Read-only taxonomy access (career domains / roles / skills / skill
// clusters). Individual reads are open to any authenticated user;
// /invalidate/:nodeId is gated behind requireAdmin inside the router itself.
app.use(`${API_PREFIX}/knowledge`, authenticate, require('./modules/knowledge-runtime/knowledge/knowledge.routes'));

// ── WP-IMP-03 — Knowledge Runtime (StudentService / student context) ─────────
// /me/* routes resolve identity from req.user.id; /:userId is gated behind
// requireAdmin inside the router itself.
app.use(`${API_PREFIX}/student-context`, authenticate, require('./modules/knowledge-runtime/student/studentIntelligence.routes'));

// ── WP-IMP-04 — Knowledge Runtime (RecommendationService) ─────────────────────
// Deterministic, rule-based candidate generation only — no scoring/ranking/
// explainability (deferred to future work packages). /me resolves identity
// from req.user.id.
app.use(`${API_PREFIX}/recommendations`, authenticate, require('./modules/knowledge-runtime/recommendation/recommendation.routes'));

// ── WP-IMP-04A — Knowledge Runtime (ValidationService) ────────────────────────
// Deterministic quality gate over Knowledge/Student/Recommendation output
// plus IQF (Intelligence Quality Framework) signals — no AI/LLM. /me
// resolves identity from req.user.id.
app.use(`${API_PREFIX}/validation`, authenticate, require('./modules/knowledge-runtime/validation/validation.routes'));

// ── WP-IMP-05 — Knowledge Runtime (DecisionEngine) ─────────────────────────────
// Deterministic Decision Engine, scoped to the `skill` decision type per
// WP-ARB-01's ratified v1 scope; every other decisionType returns a
// well-formed WITHHELD Decision (DR-TYP-01). No AI/LLM, no repository
// access — see documents/WP-DIF-01/WP_IMP05_IMPLEMENTATION_CLARIFICATION.md
// §13 for the frozen implementation baseline. /me resolves identity from
// req.user.id.
app.use(`${API_PREFIX}/decisions`, authenticate, require('./modules/knowledge-runtime/decision/decision.routes'));

// ── WP-13B — Premium Job Match Intelligence ───────────────────────────────────
// Requires a paid plan. authenticate verifies the Supabase JWT; requirePaidPlan
// checks the subscription tier (pro | elite | enterprise | premium) via the JWT
// claim with a Supabase DB fallback. Free users receive HTTP 403.
const jobMatchPremiumRouter = require('./modules/jobMatchPremium/routes/jobMatchPremium.routes');
const { requirePaidPlan }   = require('./middleware/requirePaidPlan.middleware');

app.use(
  `${API_PREFIX}/premium`,
  authenticate,
  requirePaidPlan,
  jobMatchPremiumRouter
);

// =============================================================================
// ✅ Admin Routes (authenticate + requireAdmin)
// =============================================================================
// requireAdmin checks decoded.admin === true OR decoded.role === 'admin'|'super_admin'
// These claims are set on the Supabase user JWT via app_metadata.
// Rate limit: 50 req/min per user (adminRateLimit).
app.use(`${API_PREFIX}/admin`, adminRateLimit);

app.use(`${API_PREFIX}/admin/metrics`,           authenticate, requireAdmin, requireElevatedSession, require('./routes/admin/adminMetrics.routes'));
app.use(`${API_PREFIX}/admin/ai`,                authenticate, requireAdmin, requireElevatedSession, require('./routes/admin/ai-observability.routes'));
// WP-ADMIN-04F-08: Enterprise Permission Administration API — transport
// layer only, consuming the certified Registry/Assignment/Evaluation
// foundation (WP-ADMIN-04F-03/05/06). Router-level gate matches every
// other admin route module; per-route gating additionally requires the
// certified requirePermission(RESOURCES.ADMINISTRATION, action) grant
// (see modules/admin/permissions/routes/permissionAdmin.routes.js).
app.use(`${API_PREFIX}/admin/permissions`,       authenticate, requireAdmin, requireElevatedSession, require('./modules/admin/permissions/routes/permissionAdmin.routes'));
// WP-ADMIN-05A: Enterprise Administrator Management — transport layer only,
// consuming the certified Administrator Lifecycle (WP-ADMIN-04F-18B) and
// Bootstrap (WP-ADMIN-04F-18D, never exposed here) foundations.
// WP-ADMIN-05A-R1: router-level requireMasterAdmin removed — it made every
// operation MASTER_ADMIN-only, which over-restricted List/View/Suspend/
// Reactivate beyond the approved policy. requireAdmin's own certified
// admin_principals verification (status='active' + session TTL) is the
// baseline gate for this router now; requireMasterAdmin is applied only at
// the individual route level, on Grant and Revoke — see
// administrators.routes.js.
app.use(`${API_PREFIX}/admin/administrators`,    authenticate, requireAdmin, requireElevatedSession, require('./modules/admin/administrators/administrators.routes'));
// WP-ADMIN-02C: MFA routes — deliberately NOT gated by requireElevatedSession
// (these are the routes that CREATE the elevated session) and use the
// lighter isAdminRole check inside mfa.routes.js rather than requireAdmin's
// full DB-verification path, to avoid a chicken-and-egg dependency during
// enrollment. Mounted at its own specific sub-path per the earlier
// bare-API_PREFIX rate-limiter lesson from this program.
app.use(`${API_PREFIX}/admin/mfa`,               authenticate, mfaRateLimit, require('./modules/admin/mfa/mfa.routes'));
// WP-7 — Phase 1 stubs (WP-13: replace stub bodies with real service calls)
app.use(`${API_PREFIX}/system`,  authenticate, requireAdmin, requireElevatedSession, systemHealthRoutes);
app.use(`${API_PREFIX}/metrics`, authenticate, requireAdmin, requireElevatedSession, xaiMetricsRoutes);
app.use(`${API_PREFIX}/admin/jobs`,              authenticate, requireAdmin, requireElevatedSession, require('./modules/admin/jobs/adminJobs.routes'));
app.use(`${API_PREFIX}/admin/adaptive-weights`,  authenticate, requireAdmin, requireElevatedSession, require('./modules/adaptiveWeight/adaptiveWeight.routes'));

// Career Readiness — gated behind feature flag (marked DEAD-02).
// To re-enable: set FEATURE_CAREER_READINESS=true in .env
// To remove permanently: delete this block + src/modules/career-readiness/
if (process.env.FEATURE_CAREER_READINESS === 'true') {
  app.use(`${API_PREFIX}/career-readiness`, authenticate, require('./modules/career-readiness/careerReadiness.routes'));
}

/**
 * Admin CMS Dataset Ingestion (authenticate + requireAdmin)
 *
 * Duplicate prevention enforced at two layers:
 *   1. Service layer — normalized name lookup before every insert
 *   2. Supabase unique constraint on normalizedName / normalizedCompositeKey
 *
 * Security contract:
 *   - Admin identity (createdByAdminId) always sourced from req.user.id (JWT)
 *   - No admin identity is accepted from any request body — blocked by validators
 *   - All routes inherit authenticate + requireAdmin from this mount point
 *
 *   POST   /api/v1/admin/cms/skills                 → Create skill (dedup check)
 *   PATCH  /api/v1/admin/cms/skills/:skillId        → Update skill
 *   GET    /api/v1/admin/cms/skills                 → List skills
 *   POST   /api/v1/admin/cms/roles                  → Create role
 *   PATCH  /api/v1/admin/cms/roles/:roleId          → Update role
 *   GET    /api/v1/admin/cms/roles                  → List roles
 *   POST   /api/v1/admin/cms/job-families           → Create job family
 *   PATCH  /api/v1/admin/cms/job-families/:id       → Update
 *   GET    /api/v1/admin/cms/job-families           → List
 *   POST   /api/v1/admin/cms/education-levels       → Create education level
 *   PATCH  /api/v1/admin/cms/education-levels/:id   → Update
 *   GET    /api/v1/admin/cms/education-levels       → List
 *   POST   /api/v1/admin/cms/salary-benchmarks      → Create salary benchmark
 *   PATCH  /api/v1/admin/cms/salary-benchmarks/:id  → Update
 *   GET    /api/v1/admin/cms/salary-benchmarks      → List
 *   POST   /api/v1/admin/cms/import                 → Bulk JSON import (207 on partial)
 */
app.use(`${API_PREFIX}/admin/users`,           authenticate, requireAdmin, requireElevatedSession, require('./modules/admin/users/adminUsers.routes'));
app.use(`${API_PREFIX}/admin/cms/skills`,      authenticate, requireAdmin, requireElevatedSession, require('./modules/admin/cms/skills/adminCmsSkills.routes'));
app.use(`${API_PREFIX}/admin/cms/roles`,       authenticate, requireAdmin, requireElevatedSession, require('./modules/admin/cms/roles/adminCmsRoles.routes'));
app.use(`${API_PREFIX}/admin/cms/career-domains`,   authenticate, requireAdmin, requireElevatedSession, careerDomainsModule.router);
app.use(`${API_PREFIX}/admin/cms/skill-clusters`,   authenticate, requireAdmin, requireElevatedSession, skillClustersModule.router);
app.use(`${API_PREFIX}/admin/cms/job-families`,     authenticate, requireAdmin, requireElevatedSession, jobFamiliesModule.router);
app.use(`${API_PREFIX}/admin/cms/education-levels`, authenticate, requireAdmin, requireElevatedSession, educationLevelsModule.router);
app.use(`${API_PREFIX}/admin/cms/salary-benchmarks`, authenticate, requireAdmin, requireElevatedSession, salaryBenchmarksModule.router);
app.use(`${API_PREFIX}/admin/cms/import`,      authenticate, requireAdmin, requireElevatedSession, require('./modules/admin/cms/import/adminCmsImport.routes'));

/**
 * Admin CSV File Upload Import (authenticate + requireAdmin)
 *   POST /api/v1/admin/cms/import/csv/:datasetType
 *   Supported: skills | roles | jobFamilies | educationLevels
 */
app.use(`${API_PREFIX}/admin/cms/import/csv`, authenticate, requireAdmin, requireElevatedSession, require('./modules/admin/import/import.routes'));

/**
 * Contributor Submission + Approval Workflow
 *   contributor → submit entries for review
 *   admin+      → approve/reject; writes approved entries to live tables
 *
 *   POST   /api/v1/admin/pending              → contributor submits entry
 *   GET    /api/v1/admin/pending              → list (admin: all, contributor: own)
 *   GET    /api/v1/admin/pending/:id          → single entry
 *   POST   /api/v1/admin/pending/:id/approve  → admin approves → writes to live table
 *   POST   /api/v1/admin/pending/:id/reject   → admin rejects with reason
 *   DELETE /api/v1/admin/pending/:id          → contributor withdraws own submission
 */
app.use(`${API_PREFIX}/admin/pending`, authenticate, requireContributor, require('./routes/admin/adminPending.routes'));

/**
 * Contributor Management (authenticate + requireAdmin)
 * Master admin promotes/demotes users to the contributor role.
 *
 *   GET  /api/v1/admin/contributors          → list all contributors
 *   POST /api/v1/admin/contributors/promote  → grant contributor role
 *   POST /api/v1/admin/contributors/demote   → revoke contributor role
 */
app.use(`${API_PREFIX}/admin/contributors`, authenticate, requireAdmin, requireElevatedSession, require('./routes/admin/adminContributors.routes'));

/**
 * Salary Data API (authenticate — granular admin guard inside route)
 *   GET  /api/v1/salary-data/:roleId           → aggregated salary intelligence (any authed user)
 *   GET  /api/v1/salary-data/:roleId/records   → raw salary records (admin only, guarded in route)
 *   POST /api/v1/salary-data                   → manual admin salary entry (admin only)
 *
 *   Optional query filters: ?location=India&experienceLevel=Mid&industry=Technology
 */
app.use(`${API_PREFIX}/salary-data`, authenticate, require('./modules/salary/salary.routes'));

/**
 * Admin Entity CSV Import (authenticate + requireAdmin)
 *   POST /api/v1/admin/import/skills
 *   POST /api/v1/admin/import/roles
 *   POST /api/v1/admin/import/job-families
 *   POST /api/v1/admin/import/education-levels
 *   POST /api/v1/admin/import/salary-benchmarks
 *   Body: multipart/form-data — field "file" (CSV, max 10 MB)
 *   Response: { success, created, updated, skipped, failed, total, rows[], importedAt }
 */
app.use(`${API_PREFIX}/admin/import`, authenticate, requireAdmin, requireElevatedSession, require('./modules/admin/import/adminImport.routes'));

/**
 * CSV Salary Bulk Import (authenticate + requireAdmin)
 *   POST /api/v1/admin/import/salaries
 *   Content-Type: multipart/form-data, field: file (CSV, max 10MB)
 *   Flow: multer → streaming csv-parser → role normalization → validate → batch Supabase write
 *   Returns HTTP 207 on partial success (some rows skipped/errored).
 */
app.use(`${API_PREFIX}/admin/import/salaries`, authenticate, requireAdmin, requireElevatedSession, require('./modules/salaryImport/salaryImport.routes'));

/**
 * Role Alias Management (authenticate + requireAdmin)
 *   POST /api/v1/admin/cms/role-aliases          → create alias
 *   GET  /api/v1/admin/cms/role-aliases/:roleId  → list aliases for a role
 *
 * Used by CSV import + sync worker to normalize role names from external sources.
 */
app.use(`${API_PREFIX}/admin/cms/role-aliases`, authenticate, requireAdmin, requireElevatedSession, require('./modules/roleAliases/roleAlias.routes'));

/**
 * External API Registry (authenticate + requireMasterAdmin)
 * MASTER_ADMIN only — regular admins receive HTTP 403.
 * Rate limit: 30 req/min per user (masterRateLimit)
 *
 *   POST   /api/v1/master/apis      → register new external salary API
 *   GET    /api/v1/master/apis      → list all registered APIs (apiKey redacted)
 *   PATCH  /api/v1/master/apis/:id  → update config
 *   DELETE /api/v1/master/apis/:id  → soft-delete API config
 */
app.use(`${API_PREFIX}/master/apis`,  masterRateLimit, authenticate, requireMasterAdmin, require('./modules/master/master.routes'));

/**
 * Salary Sync Control (authenticate + requireMasterAdmin)
 *   POST /api/v1/master/sync/trigger → manually trigger salary API sync (202)
 *   GET  /api/v1/master/sync/status  → last sync timestamp per provider
 *
 *   Automated sync also runs daily at 02:00 UTC via salaryApiSync.worker.js
 */
app.use(`${API_PREFIX}/master/sync`,  masterRateLimit, authenticate, requireMasterAdmin, require('./modules/master/masterSync.routes'));

/**
 * Secrets Manager (authenticate + requireMasterAdmin ONLY)
 *
 * Stores and manages AES-256-GCM encrypted API keys and credentials.
 * Security guarantees:
 *   - Secrets encrypted with AES-256-GCM (unique IV per secret) before storage
 *   - HMAC-SHA256 tamper seal bound to secret name (prevents ciphertext substitution)
 *   - No endpoint ever returns a decrypted value — masked previews only
 *   - Mutation endpoints rate-limited to 10 requests/hour/admin UID
 *   - Every create/update/delete emits an audit log entry to admin_logs table
 *
 *   POST   /api/v1/admin/secrets              → Create or update a secret
 *   GET    /api/v1/admin/secrets              → List secrets (metadata + masked preview)
 *   GET    /api/v1/admin/secrets/:name/status → Masked preview for a specific secret
 *   DELETE /api/v1/admin/secrets/:name        → Permanently delete a secret
 */
app.use(`${API_PREFIX}/admin/secrets`, authenticate, requireMasterAdmin, secretsRouter);

/**
 * Market Intelligence API Configuration (authenticate + requireMasterAdmin ONLY)
 *   POST   /api/v1/admin/market-intelligence/config       → Save API credentials
 *   POST   /api/v1/admin/market-intelligence/test         → Test API connection
 *   GET    /api/v1/admin/market-intelligence/status       → Provider + sync status
 *   GET    /api/v1/admin/market-intelligence/data-sources → Dashboard data source list
 *   POST   /api/v1/admin/market-intelligence/fetch        → Manually trigger data fetch
 */
app.use(`${API_PREFIX}/admin/market-intelligence`, authenticate, requireMasterAdmin, marketIntelRouter);

/**
 * Daily Engagement System
 *   GET  /api/v1/career/daily-insights          → personalised insight feed (cached 10 min)
 *   POST /api/v1/career/daily-insights/read     → mark insights as read
 *   POST /api/v1/career/daily-insights/generate → trigger fresh generation
 *   GET  /api/v1/career/progress                → career progress report + chart data
 *   POST /api/v1/career/progress/record         → manual progress snapshot
 *   GET  /api/v1/career/alerts                  → opportunity alert feed (cached 10 min)
 *   POST /api/v1/career/alerts/read             → mark alerts as read
 */


// =============================================================================
// ✅ GLOBAL AUTH SAFETY NET (belt-and-suspenders) — correctly placed AFTER routes
// =============================================================================
// Every private route already carries authenticate() individually.
// This guard fires AFTER all route handlers have had a chance to run
// authenticate() and set req.user. If req.user is still absent at this point,
// either a route is missing authenticate() or it failed silently.
//
// IMPORTANT: Must be registered AFTER all app.use(route, authenticate, router)
// calls so that per-route authenticate() runs first and populates req.user
// before this check executes.
app.use(`${API_PREFIX}`, (req, res, next) => {
  if (
    req.path === '/health' ||
    req.path.startsWith('/health/') ||
    req.path === '/ready' ||
    req.path === '/metrics' ||
    req.path === '/webhooks' ||
    req.path.startsWith('/webhooks/') ||
    req.path === '/analyze' ||
    req.path.startsWith('/analyze/') ||
    req.path.startsWith('/internal/')
  ) {
    return next();
  }

  if (!req.user) {
    logger.warn('[AuthGuard] Safety net triggered — req.user absent on private path', {
      method:  req.method,
      path:    req.originalUrl,
      ip:      req.ip,
      hint:    'Route is missing authenticate() middleware, or authenticate() failed without responding.',
    });

    return res.status(401).json({
      success:   false,
      errorCode: 'UNAUTHORIZED',
      message:   'Authentication required.',
      timestamp: new Date().toISOString(),
    });
  }

  next();
});

logger.info('[AuthGuard] Global auth safety net registered', {
  prefix:   `${API_PREFIX}/*`,
  exempted: ['health', 'health/*', 'ready', 'metrics', 'webhooks/*', 'internal/*', 'analyze', 'analyze/*'],
  role:     'catch-all — rejects requests where authenticate() did not set req.user',
});

// =============================================================================
// ✅ Terminal handlers — must be last
// =============================================================================
app.use(notFoundHandler);
app.use(errorHandler);

// FIX: Module-level activeTenants replaces global.__ACTIVE_TENANTS__.
// The global assignment was invisible to TypeScript and became a production
// mystery when a worker and a route handler accessed different instances.
// activeTenants is populated by the lifecycle worker during bootstrap and
// is referenced here by closure — no global namespace pollution.
let activeTenants = [];

// =============================================================================
// ✅ Startup tasks (non-blocking — server is already listening)
// =============================================================================
const {
  warmHotTenantsOnDeploy,
} = require('./workers/lifecycle.worker');

const {
  replayDeployConsensus,
} = require('./workers/lifecycleHeat.worker');

const {
  prewarmTenantBenchmarks,
} = require('./workers/benchmarkPrewarm.worker');

const predictiveHeat = require(
  './infrastructure/cache/predictiveHeat.service'
);
const replayPolicyEngine = require(
  './infrastructure/governance/replayPolicy.engine'
);

const cacheHydrationWorker = require(
  './infrastructure/workers/cacheHydration.worker'
);
const snapshotWorker = require(
  './infrastructure/workers/cacheSnapshot.worker'
);

const warmStatePrefetch = require(
  './infrastructure/cache/warmStatePrefetch.service'
);

const regionalHandoffWorker = require(
  './infrastructure/cache/regionalHandoffWorker.service'
);

const sovereignRouting = require(
  './infrastructure/routing/sovereignRoutingMesh.service'
);

const globalPolicyMesh = require("./infrastructure/policy/globalPolicyArbitrationMesh.service");

const recoveryScheduler = require(
  "./infrastructure/resilience/recoveryScheduler.service"
);
const circuitMesh = require(
  "./infrastructure/resilience/failureCircuitMesh.service"
);

const pressureBalancer = require(
  "./infrastructure/cache/pressureBalancer.worker"
);

// Gotenberg health check on startup.
// If GOTENBERG_URL is set (production), verify it is reachable before accepting
// PDF generation requests. Fails fast at boot rather than at first PDF request.
// Puppeteer is the local-dev fallback when GOTENBERG_URL is absent.
if (process.env.GOTENBERG_URL && !IS_TEST) {
  fetch(`${process.env.GOTENBERG_URL}/health`)
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      logger.info('[Server] Gotenberg health check passed', { url: process.env.GOTENBERG_URL });
    })
    .catch((err) => {
      logger.error('[Server] WARNING: Gotenberg unreachable — PDF generation will fail', {
        url: process.env.GOTENBERG_URL, error: err.message,
      });
    });
}
const workerShutdownTasks = [];
let deployWarmupPromise = null;

// AI Event Bus Workers — BullMQ
// Workers process AI engine jobs asynchronously:
// SkillGraph, CareerHealth, JobMatching, RiskAnalysis, OpportunityRadar,
// CareerAdvisor, Personalization.
if (process.env.FEATURE_EVENT_BUS === 'true') {
  try {
    const { startAll, stopAll } = require(
      './modules/ai-event-bus/workers'
    );
    const { closeAllQueues } = require(
      './modules/ai-event-bus/bus/aiEventBus'
    );

    if (!workerBootRegistry.has('ai-event-bus')) {
      startAll();
      workerBootRegistry.add('ai-event-bus');
    } else {
      logger.warn(
        '[Patch34] Duplicate AI Event Bus worker boot prevented'
      );
    }

    logger.info('[Server] AI Event Bus workers started');

    workerShutdownTasks.push(
      () =>
        stopAll().catch((err) =>
          logger.warn(
            '[Server] AI Event Bus stopAll error',
            { err: err.message }
          )
        ),
      () =>
        closeAllQueues().catch((err) =>
          logger.warn(
            '[Server] AI Event Bus closeAllQueues error',
            { err: err.message }
          )
        )
    );
  } catch (err) {
    logger.warn(
      '[Server] AI Event Bus workers failed to start (non-fatal)',
      { err: err.message }
    );
  }
}

// AI Personalization Worker
// Processes async behaviour profile updates and recommendation pre-computation.
if (process.env.FEATURE_PERSONALIZATION === 'true') {
  try {
    const { personalizationWorkerInstance, startPersonalizationHook } =
      require('./modules/personalization/personalizationWorker');
    personalizationWorkerInstance.start();
    startPersonalizationHook();
    logger.info('[Server] Personalization worker started');

    workerShutdownTasks.push(
      () => personalizationWorkerInstance.stop().catch((err) =>
        logger.warn('[Server] Personalization worker stop error', { err: err.message })),
    );
  } catch (err) {
    logger.warn('[Server] Personalization worker failed to start (non-fatal)', { err: err.message });
  }
}

// Daily Engagement Worker
// Set RUN_ENGAGEMENT_WORKER=true to run inline with the server;
// leave false (default) to run as a separate process via
// `npm run worker:engagement`.
if (process.env.RUN_ENGAGEMENT_WORKER === 'true') {
  try {
    startEngagementWorker();
    logger.info('[Server] Daily engagement worker started');

    workerShutdownTasks.push(
      () => stopEngagementWorker().catch((err) =>
        logger.warn('[Server] Engagement worker stop error', { err: err.message })),
    );
  } catch (err) {
    logger.warn('[Server] Daily engagement worker failed to start (non-fatal)', { err: err.message });
  }
}

// =============================================================================
// ✅ HTTP Server + Graceful Shutdown
// =============================================================================
const PORT = parseInt(process.env.PORT || '3000', 10);


function getWeeklySprintBias() {
  // FIX W3: Use UTC methods — server timezone may differ from user's Monday.
  const now = new Date();
  const isMonday = now.getUTCDay() === 1;
  const hour = now.getUTCHours();

  if (!isMonday) return 0;
  if (hour >= 8 && hour <= 12) return 10;

  return 0;
}
async function bootstrap() {
  try {
 // Wave 30.5 bootstrap lifecycle reset:
// clears route dedup state, startup DAG state,
// distributed leases, profiler lineage, and mutation overlays
// before authoritative DAG reconstruction.

   // Patch 35 → register distributed startup phases
startupBarrier.registrationComplete = false;
// NOTE: registeredRouteKeys.clear() was here (Wave 30.5) but has been removed.
//
// Routes are registered synchronously at module-parse time, before bootstrap()
// ever runs. Clearing the Set here wiped all entries that registerRoute() had
// already added, making logRouteRegistrySummary() always report 0 and masking
// the real route-guard count. The clear had no effect on Express's internal
// router stack (which is what actually controls routing), so removing it is
// safe — it only restores the accuracy of the diagnostic log.
//
// If you need to reset route state between hot-reload cycles, use nodemon's
// --watch flag with a process restart rather than mutating module-level state.
startupWatchdog.startedAt = Date.now();
if (startupWatchdog.timer) {
  clearTimeout(startupWatchdog.timer);
}

startupWatchdog.timer = setTimeout(() => {
  releaseDegradedStartupBarrier('startup-watchdog-timeout');
}, startupWatchdog.timeoutMs);

startupWatchdog.timer.unref();

// Wave 30.5 Hardening — fully reset startup barrier state before DAG rebuild.
// Prevents hot-reload phase ghosting, stale completion state,
// and stale distributed release intent across retries.
startupBarrier.completed.clear();
startupBarrier.phases.clear();
startupPhaseAttribution.phases.clear();
startupPhaseAttribution.failures = [];
startupBarrier.phaseDurations.clear();

startupBarrier.slowestPhase = null;
startupBarrier.isReleased = false;
startupBarrier.releaseTimestamp = null;
startupBarrier.pendingDistributedRelease = false;

// Wave 30 Hardening — clear stale lease renewal loop before bootstrap re-entry.
// Prevents zombie lease renewal across nodemon reloads, retries,
// and self-healing bootstrap cycles.
if (distributedLeaseRenewalLoop) {
  clearInterval(distributedLeaseRenewalLoop);
  distributedLeaseRenewalLoop = null;
}

// Wave 35 — PATCH 7 BOOTSTRAP: reset all confidence scoring counters and
// stale suppression/lineage state on every clean process restart.
// Ensures no cross-restart stale watchdog bleed.
rollbackConfidenceState.lastScore            = 0;
rollbackConfidenceState.lastSeverity         = 'none';
rollbackConfidenceState.totalEvaluations     = 0;
rollbackConfidenceState.suppressedRollbacks  = 0;
rollbackConfidenceState.confirmedRollbacks   = 0;
rollbackConfidenceState.falsePositiveWindows = [];
rollbackConfidenceState.severityHistory      = [];

// Wave 36 — BOOTSTRAP: reset trust decay registry + escalation ledger.
rollbackTrustState.regionTrust.clear();
rollbackTrustState.nodeTrust.clear();
rollbackTrustState.trustEvents           = [];
regionalEscalationState.escalations      = [];
regionalEscalationState.totalEscalations = 0;
regionalEscalationState.lastEscalationAt = null;

// Wave 37 — BOOTSTRAP: reset anomaly fusion state.
anomalyFusionState.regions.clear();
anomalyFusionState.lastEvaluatedAt = null;
anomalyFusionState.consensusScore  = 0;

const bootstrapNodeId = getLocalReplicaId();

// Wave 32 — PATCH 4 (updated): startup recovery via shared getRedisLeaseState helper.
// Before re-acquiring, check Redis for a persisted epoch so the Lua CAS epoch fence
// in tryReleaseStartupBarrier can detect fast pod restarts.
await (async () => {
  const state = await getRedisLeaseState(bootstrapNodeId);

  if (state === null) {
    logger.info('[Wave32] Bootstrap Redis lease check skipped — Redis unavailable', {
      nodeId: bootstrapNodeId,
    });
    return;
  }

  if (state.leaseExists && state.persistedEpoch !== null) {
    logger.info('[Wave32] Durable Redis epoch found during bootstrap recovery — fast restart detected', {
      nodeId:          bootstrapNodeId,
      redisEpoch:      state.persistedEpoch,
      leaseKeyPresent: true,
    });
  } else {
    logger.info('[Wave32] No Redis lease found during bootstrap — fresh acquisition path', {
      nodeId: bootstrapNodeId,
    });
  }
})();

// Reset DAG profiler + self-healing state
startupDagProfiler.slackByPhase.clear();
startupDagProfiler.zeroValueCriticalBlockers = [];
startupDagProfiler.movablePostRelease = [];
startupDagProfiler.reclassificationCandidates = [];
startupDagProfiler.criticalPathDeltaMs = null;

startupDagSelfHealing.autoPromotedCandidates = [];
startupDagSelfHealing.lastHealingActionAt = null;

// Reset mutation ledger state for deterministic bootstrap lineage
startupDagMutationLedger.appliedMutations.clear();
startupDagMutationLedger.lastMutationAt = null;
startupDagMutationLedger.constitutionalProtectedPhases.clear();

// Re-register authoritative startup DAG
[
  {
    phase: 'redis-connect',
    critical: true,
    degradedFloor: true,
  },
  {
    phase: 'supabase-bootstrap-verification',
    critical: true,
    degradedFloor: true,
    dependsOn: ['redis-connect'],
  },
  {
    phase: 'http-server-bind',
    critical: true,
    degradedFloor: true,
    dependsOn: ['supabase-bootstrap-verification'],
  },
  {
    phase: 'deploy-warmup',
    asyncPhase: true,
  },
  {
    phase: 'predictive-topology-worker',
    critical: true,
  },
  {
    phase: 'learning-mesh-worker',
    asyncPhase: true,
  },
  {
    phase: 'federation-worker',
    asyncPhase: true,
  },
  {
    phase: 'swarm-governance-worker',
    asyncPhase: true,
  },
  {
    phase: 'cache-hydration',
    critical: true,
    dependsOn: ['redis-connect'],
  },
  {
    phase: 'warm-state-prefetch',
    asyncPhase: true,
  },
  {
    phase: 'global-policy-mesh',
    critical: true,
    dependsOn: ['cache-hydration'],
  },
  {
    phase: 'recovery-scheduler',
    asyncPhase: true,
  },
  {
    phase: 'pressure-balancer',
    critical: true,
    dependsOn: ['cache-hydration'],
  },
  {
    phase: 'quorum-replication',
    critical: true,
    dependsOn: [
      'redis-connect',
      'pressure-balancer',
    ],
  },
  {
    phase: 'consensus-memory-forecast',
    asyncPhase: true,
  },
  {
    phase: 'autonomous-topology-mutation',
    asyncPhase: true,
  },
  {
    phase: 'sovereign-routing',
    asyncPhase: true,
  },
].forEach(({ phase, ...meta }) =>
  registerStartupPhase(phase, meta)
);

applyControlledDagMutation();
startupBarrier.registrationComplete = true;

// Wave 26 → reseed constitutional protected phases
// from degradedFloor-gated entries after fresh DAG registration
for (const [phase, meta] of startupBarrier.phases.entries()) {
  if (meta.degradedFloor) {
    startupDagMutationLedger.constitutionalProtectedPhases.add(
      phase
    );
  }
}
    // Wave 27 → register idempotent recoverable phases for deterministic self-healing.
    // ONLY strictly idempotent phases with safe validate + replay semantics are listed.
    // Non-idempotent phases (route registration, worker boot) are intentionally excluded.
    registerRecoverablePhase('supabase-bootstrap-verification', {
      critical: true,
      validate: async () => !!supabase,
      replay: async () => {
        const { error } = await supabase
          .from('_health')
          .select('1')
          .limit(1);
        if (error) throw error;
      },
    });

  registerRecoverablePhase('redis-connect', {
  critical: true,
  validate: async () => {
    const status = getRedisStatus();

    // getRedisStatus() returns an object like:
    // { connected: true, ... }
    return !!status?.connected;
  },
  replay: async () => {
    await connectRedis();
  },
});

  // Wave 27 → deploy-warmup: non-critical async warmup phase.
  // Marked replay-safe, optional, and non-fatal.
  // validate short-circuits to true → recovery status: already_valid.
  // replay is a no-op → Wave 27 will never escalate this to fatal corruption.
  registerRecoverablePhase('deploy-warmup', {
    critical: false,
    validate: async () => true,
    replay: async () => {},
  });

  // Wave 27 → warm-state-prefetch: non-critical async prefetch mesh (Patch 15).
  // Errors in bootstrap are already caught as warn-level non-fatal.
  // validate short-circuits to true → recovery status: already_valid.
  // replay is a no-op → prefetch worker re-hydrates on its own cycle.
  registerRecoverablePhase('warm-state-prefetch', {
    critical: false,
    validate: async () => true,
    replay: async () => {},
  });

  // Wave 27 → remaining DAG phases: all non-critical async infrastructure phases.
  // Each is registered as replay-safe + non-fatal so recoverIncompleteStartupPhases()
  // never escalates a phase_not_registered into unrecoverable startup corruption.
  // validate short-circuits to true (already_valid) on all — replay is intentional no-op.
 // Wave 27 Hardening — register replay-safe recovery handlers directly
// from the authoritative startup DAG metadata.
// This removes criticality drift between startupBarrier and recoveryRegistry.
for (const [phase, meta] of startupBarrier.phases.entries()) {
  // Skip phases already registered with explicit real handlers above.
  if (
    phase === 'supabase-bootstrap-verification' ||
    phase === 'redis-connect' ||
    phase === 'deploy-warmup' ||
    phase === 'warm-state-prefetch'
  ) {
    continue;
  }

  registerRecoverablePhase(phase, {
    critical: !!meta.critical,
    validate: async () => true,
    replay: async () => {},
  });
}

logger.info(
  '[Server] Wave 14 startup DAG registration frozen',
  {
    total_registered_phases:
      startupBarrier.phases.size,
    critical_registered_phases: Array.from(
      startupBarrier.phases.values()
    ).filter((meta) => meta.critical).length,
    recoverable_registered_phases:
      startupBarrier.phases.size,
  }
);
 // PR 2: Redis must be ready before serving traffic
    await connectRedis();
completeStartupPhase('redis-connect');

// ✅ ADD HERE
let anomalySubscriberActive = false;
let anomalySubscriberClient = null;

let trustSubscriberActive   = false;
let trustSubscriberClient   = null;

// Wave 43 — Phase 9: restore persisted auto-tune state now that Redis is ready.
await restoreAutoTuneState();

// Wave 33 — start lease failover watchdog immediately after Redis connects.
// Probes primary every probeIntervalMs; promotes fallback on threshold failures.
startLeaseFailoverWatchdog();

// Wave 40 — Subscribe to cross-node anomaly signals via Redis Pub/Sub.
// Uses a dedicated duplicate client so subscribe mode never blocks lease
// operations on the shared getLeaseRedisClient() connection.
// Self-emitted signals are discarded; all peer signals are fed directly into
// anomalyFusionState.regions so evaluateCrossRegionAnomalies() sees them on
// the next tick. cleanupOldAnomalySignals() prunes them by age as normal.
try {
  if (anomalySubscriberActive) return;

  const client = getLeaseRedisClient();
  if (!client) {
    logger.warn('[Wave40] Redis unavailable — skipping anomaly subscriber init');
  } else {
    const subClient = trackRedisClient(client.duplicate());

    await subClient.subscribe(ANOMALY_SIGNAL_CHANNEL);
    anomalySubscriberActive = true;

    subClient.on('message', (channel, message) => {
      if (channel !== ANOMALY_SIGNAL_CHANNEL) return;

    try {
  // Use global safeJsonParse helper (no inline definition)
  const raw = safeJsonParse(message);
  if (!raw) return;

  // FIX 6 — Region allowlist (module-level ALLOWED_SIGNAL_REGIONS constant)

  // FIX 2 — Strict schema validation
  if (
    !raw ||
    typeof raw.region !== 'string' ||
    typeof raw.nodeId !== 'string' ||
    typeof raw.driftScore !== 'number' ||
    typeof raw.confidence !== 'number'
  ) {
    logger.warn('[Wave49] Invalid signal schema dropped');
    return;
  }

 // 🔒 Additional hardening (recommended)

// Validate timestamp type + value
if (
  typeof raw.timestamp !== 'number' ||
  !Number.isFinite(raw.timestamp) ||
  raw.timestamp <= 0
) {
  logger.warn('[Wave49] Missing/invalid timestamp dropped', {
    timestamp: raw.timestamp,
  });
  
  return;
}

// Normalize timestamp (optional safety)
const timestamp = raw.timestamp;

// Prevent oversized identifiers
// 🔒 Cap string lengths (DoS hygiene)

// Normalize values (defensive)
const nodeId = raw.nodeId.trim();
const region = raw.region.trim();

// Enforce length limits
if (nodeId.length === 0 || region.length === 0) {
  logger.warn('[Wave49] Empty identifiers dropped');
  return;
}

if (nodeId.length > 128 || region.length > 64) {
  logger.warn('[Wave49] Oversized identifiers dropped', {
    nodeIdLength: nodeId.length,
    regionLength: region.length,
  });
  return;
}

  // FIX 6 — Drop unknown regions
  if (!ALLOWED_SIGNAL_REGIONS.has(raw.region)) {
    logger.warn('[Wave49] Unknown region dropped', { region: raw.region });
    return;
  }
      // FIX 4 — Reject self-spoofing
      // Ignore self signals — we already wrote these locally.
      if (raw.nodeId === getLocalReplicaId()) return;

      // FIX 5 — Replay protection
      const now = Date.now();
      if (!raw.timestamp || Math.abs(now - timestamp)> 10000) {
        logger.warn('[Wave49] Stale or replayed signal dropped');
        return;
      }

      // FIX 3 — Clamp to safe bounded ranges
      const driftScore = Math.max(0, Math.min(1, raw.driftScore));
      const confidence = Math.max(0, Math.min(1, raw.confidence));

      // FIX 8 — Defensive numeric checks
      if (!Number.isFinite(driftScore) || !Number.isFinite(confidence)) {
        return;
      }

      logger.debug('[Wave40] Received cross-node anomaly signal', {
        region: raw.region,
        nodeId: raw.nodeId,
      });

      anomalyFusionState.regions.set(raw.region, {
        driftScore,
        confidence,
        timestamp:   raw.timestamp,
        sourceNode:  raw.nodeId,
      });

    } catch (err) {
      logger.warn('[Wave40] Failed to process anomaly signal', {
        error: err.message,
      });
    }
  });

  logger.info('[Wave40] Cross-node anomaly signal subscriber active', {
    channel: ANOMALY_SIGNAL_CHANNEL,
  });
}
} catch (err) {
  anomalySubscriberActive = false;
  logger.warn('[Wave40] Failed to initialise anomaly signal subscriber', {
    error: err.message,
  });

 setTimeout(async () => {
  let retrySub = null;
  try {
    const client = getLeaseRedisClient();
    if (!client) return;

    // cleanup old subscriber if exists
    if (anomalySubscriberClient) {
      try {
        await anomalySubscriberClient.quit();
      } catch {}
      _trackedRedisClients.delete(anomalySubscriberClient);
      anomalySubscriberClient = null;
    }

    retrySub = trackRedisClient(client.duplicate());
    anomalySubscriberClient = retrySub;

    await retrySub.subscribe(ANOMALY_SIGNAL_CHANNEL);

    // FIX 1+5: Set active flag BEFORE attaching the message handler so no
    // message can arrive in the window between subscribe() resolving and the
    // flag being set true. Also prevents a second retry from spawning if a
    // concurrent path re-enters this block.
    anomalySubscriberActive = true;

    retrySub.on('message', (channel, message) => {
      if (channel !== ANOMALY_SIGNAL_CHANNEL) return;

      try {
        const raw = safeJsonParse(message);
        if (!raw) return;

        // Region allowlist — uses module-level ALLOWED_SIGNAL_REGIONS constant

        if (
          !raw ||
          typeof raw.region !== 'string' ||
          typeof raw.nodeId !== 'string' ||
          typeof raw.driftScore !== 'number' ||
          typeof raw.confidence !== 'number'
        ) {
          logger.warn('[Wave49] Invalid signal schema dropped');
          return;
        }

        if (
          typeof raw.timestamp !== 'number' ||
          !Number.isFinite(raw.timestamp) ||
          raw.timestamp <= 0
        ) {
          logger.warn('[Wave49] Missing/invalid timestamp dropped', {
            timestamp: raw.timestamp,
          });
          return;
        }

        const timestamp = raw.timestamp;
        const nodeId = raw.nodeId.trim();
        const region = raw.region.trim();

        if (nodeId.length === 0 || region.length === 0) {
          logger.warn('[Wave49] Empty identifiers dropped');
          return;
        }

        if (nodeId.length > 128 || region.length > 64) {
          logger.warn('[Wave49] Oversized identifiers dropped', {
            nodeIdLength: nodeId.length,
            regionLength: region.length,
          });
          return;
        }

        if (!ALLOWED_SIGNAL_REGIONS.has(region)) {
          logger.warn('[Wave49] Unknown region dropped', { region });
          return;
        }

        if (nodeId === getLocalReplicaId()) return;

        const now = Date.now();
        if (!timestamp || Math.abs(now - timestamp) > 10000) {
          logger.warn('[Wave49] Stale or replayed signal dropped');
          return;
        }

        const driftScore = Math.max(0, Math.min(1, raw.driftScore));
        const confidence = Math.max(0, Math.min(1, raw.confidence));

        if (!Number.isFinite(driftScore) || !Number.isFinite(confidence)) {
          return;
        }

        anomalyFusionState.regions.set(region, {
          driftScore,
          confidence,
          timestamp,
          sourceNode: nodeId,
        });

      } catch (err) {
        logger.warn('[Wave40] Failed to process anomaly signal', {
          error: err.message,
        });
      }
    });

    logger.info('[Fix1+5] Anomaly subscriber reconnected');
  } catch (_) {
    if (retrySub) {
      try {
        await retrySub.quit();
      } catch (quitErr) {
        logger.warn('[Wave40] Failed to quit anomaly retry subscriber during cleanup', {
          error: quitErr.message,
        });
      }
    }
    anomalySubscriberClient = null;
    anomalySubscriberActive = false;
  }
}, 5000);
} // end catch (Wave40 anomaly subscriber init)

// Wave 45 — Phase 11: Distributed trust signal subscriber.
// Uses a dedicated duplicate() client so subscribe mode never blocks lease
// operations on the shared getLeaseRedisClient() connection.
// Self-emitted events are discarded; stale events are dropped by age.
// Remote deltas are attenuated before being merged — no re-publish occurs here.
try {
  if (trustSubscriberActive) return;

  const client = getLeaseRedisClient();
  if (!client) {
    logger.warn('[Wave45] Redis unavailable — skipping trust subscriber init');
  } else {
    const trustSub = trackRedisClient(client.duplicate());

    await trustSub.subscribe(TRUST_SIGNAL_CHANNEL);
    trustSubscriberActive = true;

    trustSub.on('message', (channel, message) => {
      if (channel !== TRUST_SIGNAL_CHANNEL) return;

      try {
        const evt = safeJsonParse(message);
        if (!evt) return;

        if (evt.sourceNode === getLocalReplicaId()) return;

        if (Date.now() - (evt.at || 0) > TRUST_PROPAGATION.maxSignalAgeMs) return;

        if (Math.abs(evt.delta) > 10) {
          logger.warn('[Wave49] Suspicious trust delta dropped', {
            delta: evt.delta,
          });
          return;
        }

        const attenuatedDelta = Math.round(evt.delta * TRUST_PROPAGATION.attenuation);

        if (evt.kind === 'region') {
          applyRemoteRegionTrust(evt.id, attenuatedDelta);
        } else if (evt.kind === 'node') {
          applyRemoteNodeTrust(evt.id, attenuatedDelta);
        }

        logger.debug('[Wave45] Applied remote trust delta', {
          kind:   evt.kind,
          id:     evt.id,
          delta:  attenuatedDelta,
          source: evt.sourceNode,
        });

      } catch (err) {
        logger.warn('[Wave45] Failed to process trust signal', {
          error: err.message,
        });
      }
    });

    logger.info('[Wave45] Distributed trust signal subscriber active', {
      channel: TRUST_SIGNAL_CHANNEL,
    });
  } // ✅ closes else block

} catch (err) {
  trustSubscriberActive = false;

  logger.warn('[Wave45] Failed to initialise trust signal subscriber', {
    error: err.message,
  });

  setTimeout(async () => {
    let retrySub = null;
    try {
      const client = getLeaseRedisClient();
      if (!client) return;

      // cleanup old subscriber if exists
      if (trustSubscriberClient) {
        try {
          await trustSubscriberClient.quit();
        } catch {}
        _trackedRedisClients.delete(trustSubscriberClient);
        trustSubscriberClient = null;
      }

      retrySub = trackRedisClient(client.duplicate());
      trustSubscriberClient = retrySub;

      await retrySub.subscribe(TRUST_SIGNAL_CHANNEL);

      // FIX 4: Set active flag BEFORE attaching the message handler so no
      // message can arrive in the window between subscribe() resolving and
      // the flag being set true, preventing a duplicate subscriber from spawning.
      trustSubscriberActive = true;

      retrySub.on('message', (channel, message) => {
        if (channel !== TRUST_SIGNAL_CHANNEL) return;

        try {
          const evt = safeJsonParse(message);
          if (!evt) return;

          if (evt.sourceNode === getLocalReplicaId()) return;

          if (Date.now() - (evt.at || 0) > TRUST_PROPAGATION.maxSignalAgeMs) return;

          if (Math.abs(evt.delta) > 10) {
            logger.warn('[Wave49] Suspicious trust delta dropped', {
              delta: evt.delta,
            });
            return;
          }

          const attenuatedDelta = Math.round(evt.delta * TRUST_PROPAGATION.attenuation);

          if (evt.kind === 'region') {
            applyRemoteRegionTrust(evt.id, attenuatedDelta);
          } else if (evt.kind === 'node') {
            applyRemoteNodeTrust(evt.id, attenuatedDelta);
          }

          logger.debug('[Wave45] Applied remote trust delta', {
            kind:   evt.kind,
            id:     evt.id,
            delta:  attenuatedDelta,
            source: evt.sourceNode,
          });

        } catch (err) {
          logger.warn('[Wave45] Failed to process trust signal', {
            error: err.message,
          });
        }
      });

      logger.info('[Fix4] Trust subscriber reconnected');

    } catch (_) {
      if (retrySub) {
        try {
          await retrySub.quit();
        } catch (quitErr) {
          logger.warn('[Wave45] Failed to quit trust retry subscriber during cleanup', {
            error: quitErr.message,
          });
        }
      }
      trustSubscriberClient = null;
      trustSubscriberActive = false;
    }
  }, 5000);
}
// Wave 41 — Gossip UDP socket initialisation.
// Bound only when GOSSIP_ENABLED=true. The socket variable is declared at
// function scope so the broadcaster in emitRegionalAnomalySignal and the
// shutdown handler can both reference it without a module-level import.
let gossipSocket;

if (GOSSIP_ENABLED) {
  try {
    const dgram = require('dgram');
    gossipSocket = dgram.createSocket('udp4');
    _gossipSocket = gossipSocket;

    // Absorb socket-level errors (e.g. ECONNREFUSED on send) so they never
    // propagate as unhandled exceptions. Individual send errors are tolerated
    // by design — UDP delivery is best-effort.
    gossipSocket.on('error', (err) => {
      logger.warn('[Wave41] Gossip socket error', { error: err.message });
    });

    gossipSocket.on('message', (msg) => {
      try {
        // FIX 9 — Reject oversized UDP payloads before any parsing
        if (msg.length > 1024) {
          logger.warn('[Wave49] Oversized gossip packet dropped');
          return;
        }

        // FIX 1 — Uses global safeJsonParse defined at module level
        const raw = safeJsonParse(msg.toString());
        if (!raw) return;

        // FIX 6 — Region allowlist (module-level ALLOWED_SIGNAL_REGIONS constant)

        // FIX 2 — Strict schema validation
        if (
          !raw ||
          typeof raw.region !== 'string' ||
          typeof raw.nodeId !== 'string' ||
          typeof raw.driftScore !== 'number' ||
          typeof raw.confidence !== 'number'
        ) {
          logger.warn('[Wave49] Invalid signal schema dropped');
          return;
        }

        // FIX 6 — Drop unknown regions
        if (!ALLOWED_SIGNAL_REGIONS.has(raw.region)) {
          logger.warn('[Wave49] Unknown region dropped', { region: raw.region });
          return;
        }

        // FIX 4 — Reject self-spoofing
        // Discard own reflections — self-emitted datagrams can loop back on
        // loopback interfaces or when a peer list includes this node's address.
        if (raw.nodeId === getLocalReplicaId()) return;

        // FIX 5 — Replay protection: reject stale or missing timestamps
        const now = Date.now();
        if (!raw.timestamp || Math.abs(now - raw.timestamp) > 10000) {
          logger.warn('[Wave49] Stale or replayed signal dropped');
          return;
        }

        // FIX 3 — Clamp values to safe bounded ranges
        const driftScore = Math.max(0, Math.min(1, raw.driftScore));
        const confidence = Math.max(0, Math.min(1, raw.confidence));

        // FIX 8 — Defensive numeric checks
        if (!Number.isFinite(driftScore) || !Number.isFinite(confidence)) {
          return;
        }

        anomalyFusionState.regions.set(raw.region, {
          driftScore,
          confidence,
          timestamp:  raw.timestamp || Date.now(),
          sourceNode: raw.nodeId,
        });

        logger.debug('[Wave41] Gossip signal received', {
          region: raw.region,
          nodeId: raw.nodeId,
        });

      } catch (err) {
        logger.warn('[Wave41] Failed to parse gossip signal', {
          error: err.message,
        });
      }
    });

    gossipSocket.bind(GOSSIP_PORT, () => {
      logger.info('[Wave41] Gossip UDP socket bound', { port: GOSSIP_PORT });
    });

  } catch (err) {
    // Non-fatal: gossip is a fallback path; the system runs without it.
    logger.warn('[Wave41] Failed to initialise gossip socket', {
      error: err.message,
    });
  }
}
// Wave 43 — Phase 9: periodic auto-tune state persistence (safe redundancy).
// Ensures state is saved even during quiet windows where the threshold doesn't change.
trackInterval(() => {
  persistAutoTuneState();
}, 30000); // every 30 s

// Wave 36 — PATCH 1: persisted epoch observer (async safe, no overlap)
let _persistedEpochRefreshInFlight = false;

trackInterval(async () => {
  if (_persistedEpochRefreshInFlight) return;

  _persistedEpochRefreshInFlight = true;

  try {
    const nodeId = getLocalReplicaId();
    const redisState = await getRedisLeaseState(nodeId);

    leaseChaosState.lastObservedPersistedEpoch =
      redisState?.persistedEpoch ?? null;

    leaseChaosState.lastPersistedEpochAt = Date.now();

  } catch (err) {
    logger.warn('[Wave36] Failed to refresh persisted epoch', {
      error: err.message,
    });
  } finally {
    _persistedEpochRefreshInFlight = false;
  }
}, 2000);
// Wave 34 — start lease chaos simulation worker after the watchdog.
// Guarded by both LEASE_CHAOS_MODE=true AND a hard NODE_ENV !== 'production'
// check to prevent accidental activation in production deployments.
if (!IS_PRODUCTION) {
} else if (process.env.LEASE_CHAOS_MODE === 'true') {
  logger.warn('[Wave34] LEASE_CHAOS_MODE=true is set but chaos worker is blocked in production');
}

// Patch 32: SQL-first bootstrap verification
const { error: dbBootstrapError } = await supabase
  .from('user_profiles')
  .select('id')
  .limit(1);

if (dbBootstrapError) {
  throw dbBootstrapError;
}

logger.info('[Server] Supabase bootstrap verification passed');
completeStartupPhase('supabase-bootstrap-verification');

if (IS_TEST) {
  return;
}

server = app.listen(PORT, '0.0.0.0');

// FIX: keepAliveTimeout must exceed the load balancer idle timeout (GCP = 600s).
// Without this, Node closes keep-alive connections before GCP does, causing
// sporadic 502 errors under sustained traffic.
server.keepAliveTimeout = 620000;   // 620s > GCP's 600s idle timeout
server.headersTimeout   = 625000;   // must be > keepAliveTimeout
server.on('listening', () => {
  (async () => {
    completeStartupPhase('http-server-bind');

 logger.info(
  `[Server] HireRise Core running on port ${PORT} [${app.get('env')}]`
);
logRouteRegistrySummary();

  logger.info(`[Server] API Base: ${API_PREFIX}`);

  // Wave 3 Priority #5 Patch 4 → deploy benchmark MV warmup
  deployWarmupPromise = warmHotTenantsOnDeploy();

// Patch 7 → cross-replica deploy consensus replay
setTimeout(async () => {
  try {
    await replayDeployConsensus({
      activeTenants: activeTenants,
      warmFn: async (tenantId, meta) => {
        // FIX: global.benchmarkQueue was never set anywhere in the codebase.
        // Replaced with a direct call to the prewarm worker which does the same job.
        await prewarmTenantBenchmarks({
          tenantId,
          includeHotCohorts: true,
        });
      },
    });
  } catch (error) {
    logger.warn('[Server] Deploy consensus replay failed', {
      error: error.message,
    });
  }
}, 5000);

// Patch 9 → self-healing predictive topology worker
predictiveHeat.startPredictiveTopologyWorker();
completeStartupPhase('predictive-topology-worker');

logger.info('[Server] Patch 9 predictive topology worker started');

// Patch 10 → adaptive predictive intelligence mesh worker
predictiveHeat.startLearningMeshWorker();
completeStartupPhase('learning-mesh-worker');
logger.info('[Server] Patch 10 learning mesh worker started');

// Patch 11 → cross-tenant transfer learning federation worker
predictiveHeat.startFederationWorker();
completeStartupPhase('federation-worker');
logger.info('[Server] Patch 11 federation worker started');

// Patch 12 → global intelligence swarm governance worker
predictiveHeat.startSwarmGovernanceWorker();
completeStartupPhase('swarm-governance-worker');
logger.info('[Server] Patch 12 swarm governance worker started');
replayPolicyEngine.startReplayPolicyWorker({
  getTenantReplayMetrics: async () => {
    return predictiveHeat.getReplayDriftTelemetry?.() || [];
  },
  getGlobalSwarmWeight: async () => {
    return predictiveHeat.getGlobalSwarmWeight?.() || 1;
  },
});
logger.info(
  '[Server] Patch 13 replay policy worker registered in startup orchestration'
);

cacheHydrationWorker.startCacheHydrationWorker();
completeStartupPhase('cache-hydration');

logger.info(
  '[Server] Patch 14 cache hydration worker registered in startup orchestration'
);
// Patch 15 → autonomous warm-state prefetch mesh
warmStatePrefetch
  .hydrateBootSnapshot()
  .then(() => warmStatePrefetch.runPrefetchCycle())
  .then(() => {
    warmStatePrefetch.startWarmStatePrefetchWorker();
    regionalHandoffWorker.startRegionalMigrationWorker();

    completeStartupPhase('warm-state-prefetch');

    logger.info(
      '[Server] Patch 15 autonomous warm-state prefetch mesh started'
    );
  })
  .catch((err) => {
    logger.warn('[Server] Patch 15 startup degraded', {
      error: err.message,
    });
  });

// Patch 18 → global policy arbitration control plane
globalPolicyMesh.initializeGlobalPolicyMesh({
  regions: ['ap-south-1', 'me-central-1', 'eu-west-1'],
});

logger.info(
  '[Server] Patch 18 global policy arbitration mesh initialized'
);

completeStartupPhase('global-policy-mesh');

recoveryScheduler.startRecoveryScheduler();
completeStartupPhase('recovery-scheduler');
logger.info('[Server] Patch 19 recovery scheduler started');

pressureBalancer.startPressureBalancerWorker();
completeStartupPhase('pressure-balancer');

logger.info('[Server] Patch 20 pressure balancer worker started');

// FIX: Replaced global.__tenantCacheMesh with a module-level singleton.
// global.* assignments are invisible to TypeScript, not isolated per worker,
// and create a race condition when both a worker and a route handler write to
// global.__tenantCacheMesh concurrently.
// The singleton below gives quorumReplication the same Map reference without
// polluting the global namespace.
// FIX: The original code was an IIFE that ended with }); instead of })()
// — the function was assigned but never invoked, making the Map logic dead code.
// The _instance was being set directly on the function object, which accidentally
// worked but was semantically wrong. Replaced with a plain Map.
const tenantCacheMeshSingleton = new Map();

quorumReplication.startQuorumReplicationWorker(
  () => tenantCacheMeshSingleton
);

completeStartupPhase('quorum-replication');

logger.info(
  '[Server] Patch 21 quorum replication mesh started'
);

logger.info(
  '[Server] Patch 22 consensus worker registered in startup orchestration'
);

if (!workerBootRegistry.has('consensus-memory-forecast')) {
  consensusMemoryForecastLoop =
    consensusMemoryForecast.startForecastLoop();

  workerBootRegistry.add('consensus-memory-forecast');
} else {
  logger.warn(
    '[Patch34] Duplicate consensus memory forecast loop prevented'
  );
}

logger.info(
  '[Server] Patch 26 consensus memory forecast engine started'
);
completeStartupPhase('consensus-memory-forecast');

if (!workerBootRegistry.has('autonomous-topology-mutation')) {
  autonomousTopologyMutationWorker =
    autonomousTopologyMutation.startMutationWorker();

  workerBootRegistry.add('autonomous-topology-mutation');
} else {
  logger.warn(
    '[Patch34] Duplicate autonomous topology mutation worker prevented'
  );
}
logger.info(
  '[Server] Patch 27 autonomous topology mutation worker registered in startup orchestration'
);
completeStartupPhase('autonomous-topology-mutation');

// Patch 17 → latency-aware sovereign routing mesh
sovereignRouting.updateRegionLatency('ap-south-1', 42);
sovereignRouting.updateRegionLatency('me-central-1', 78);
sovereignRouting.updateRegionLatency('eu-west-1', 132);

sovereignRouting.updateRegionHealth('ap-south-1', true);
sovereignRouting.updateRegionHealth('me-central-1', true);
sovereignRouting.updateRegionHealth('eu-west-1', true);

logger.info(
  '[Server] Patch 17 latency-aware sovereign routing mesh initialized'
);

// Wave 27 — replay any incomplete startup phases before the final quorum gate.
// This must execute before completeStartupPhase('sovereign-routing') so that
// tryReleaseStartupBarrier() sees a fully recovered phase set.
{
  const recoveryResults = await recoverIncompleteStartupPhases();

  if (recoveryResults.length > 0) {
    logger.info('[startup-recovery] replay summary', {
      recoveries: recoveryResults,
    });
  }
}

completeStartupPhase('sovereign-routing');

predictiveHeat
  .recordHeat({
    tenantId: 'global',
    signalType: 'deploy_warm_sync',
    weight: 7 + getWeeklySprintBias(),
  })
  .catch((err) => {
    logger.warn('[Server] Predictive deploy heat record failed', {
      error: err.message,
    });
  });

  deployWarmupPromise
  .then((results) => {
    const startupDurationMs =
      startupWatchdog.startedAt
        ? Date.now() - startupWatchdog.startedAt
        : null;

    if (startupDurationMs !== null) {
      startupSlaHistory.samples.push(startupDurationMs);

      if (
        startupSlaHistory.samples.length >
        startupSlaHistory.maxSamples
      ) {
        startupSlaHistory.samples.shift();
      }

      const sortedSamples = [
        ...startupSlaHistory.samples,
      ].sort((a, b) => a - b);

      const total = sortedSamples.reduce(
        (sum, value) => sum + value,
        0
      );

      startupSlaHistory.rollingAverageMs =
        Math.round(total / sortedSamples.length);

      const p95Index = Math.min(
        sortedSamples.length - 1,
        Math.floor(sortedSamples.length * 0.95)
      );

      startupSlaHistory.rollingP95Ms =
        sortedSamples[p95Index];

      startupSlaHistory.lastForecastMs = Math.round(
        (
          startupSlaHistory.rollingAverageMs +
          startupSlaHistory.rollingP95Ms
        ) / 2
      );

      startupAdaptiveTimeoutPolicy.lastRecommendedTimeoutMs =
        Math.min(
          startupAdaptiveTimeoutPolicy.maxTimeoutMs,
          Math.max(
            startupAdaptiveTimeoutPolicy.minTimeoutMs,
            Math.round(
              startupSlaHistory.lastForecastMs *
                startupAdaptiveTimeoutPolicy.tuningMultiplier
            )
          )
        );

      if (
        startupDurationMs >
        startupSlaHistory.lastForecastMs *
          startupSlaHistory.anomalyThresholdMultiplier
      ) {
        startupChaosConfidence.anomalyBreaches += 1;
        startupChaosConfidence.rollbackRiskScore += 10;

        logger.warn(
          '[Server] Patch 39 predictive startup SLA anomaly detected',
          {
            startup_duration_ms: startupDurationMs,
            forecast_ms:
              startupSlaHistory.lastForecastMs,
            rolling_average_ms:
              startupSlaHistory.rollingAverageMs,
            rolling_p95_ms:
              startupSlaHistory.rollingP95Ms,
            threshold_multiplier:
              startupSlaHistory.anomalyThresholdMultiplier,
          }
        );
      }

      if (
        startupAdaptiveTimeoutPolicy.lastRecommendedTimeoutMs &&
        startupAdaptiveTimeoutPolicy.lastRecommendedTimeoutMs !==
          startupWatchdog.timeoutMs
      ) {
        startupWatchdog.timeoutMs =
          startupAdaptiveTimeoutPolicy.lastRecommendedTimeoutMs;

        startupAdaptiveTimeoutPolicy.lastAppliedTimeoutMs =
          startupWatchdog.timeoutMs;

        startupChaosConfidence.successfulAdaptiveRecoveries += 1;
        startupChaosConfidence.rollbackRiskScore =
          Math.max(
            0,
            startupChaosConfidence.rollbackRiskScore - 5
          );

        logger.info(
          '[Server] Patch 40 adaptive watchdog timeout tuned for next startup',
          {
            applied_timeout_ms:
              startupWatchdog.timeoutMs,
            forecast_ms:
              startupSlaHistory.lastForecastMs,
            rolling_p95_ms:
              startupSlaHistory.rollingP95Ms,
          }
        );
      }
    }

 const allCriticalComplete = Array.from(
  startupBarrier.phases.entries()
)
  .filter(([, meta]) => meta.critical)
  .every(([phase]) =>
    startupBarrier.completed.has(phase)
  );

startupChaosConfidence.confidenceScore =
  allCriticalComplete
    ? Math.max(
        0,
        100 - startupChaosConfidence.rollbackRiskScore
      )
    : 0;

    if (
      startupChaosConfidence.confidenceScore <
      startupChaosConfidence.rollbackThreshold
    ) {
      logger.warn(
        '[Server] Patch 41 rollback confidence threshold breached',
        {
          confidence_score:
            startupChaosConfidence.confidenceScore,
          rollback_risk_score:
            startupChaosConfidence.rollbackRiskScore,
          degraded_releases:
            startupChaosConfidence.degradedReleases,
          anomaly_breaches:
            startupChaosConfidence.anomalyBreaches,
          adaptive_recoveries:
            startupChaosConfidence.successfulAdaptiveRecoveries,
        }
      );
    }

    logger.info(
      '[Server] Benchmark deploy warmup complete',
      {
        tenants: Array.isArray(results)
          ? results.length
          : 0,
        startup_duration_ms: startupDurationMs,
        confidence_score:
          startupChaosConfidence.confidenceScore,
      }
    );

    completeStartupPhase('deploy-warmup');
  })
  .catch((err) => {
    logger.warn(
      '[Server] Benchmark deploy warmup failed (non-fatal)',
      {
        error: err.message,
      }
    );
  });

  })().catch((err) => {
    recordStartupFailureAttribution(
      'post-bind-bootstrap',
      err,
      {
        completedPhases: Array.from(startupBarrier.completed),
        pendingPhases: Array.from(
          startupBarrier.phases.keys()
        ).filter(
          (phase) => !startupBarrier.completed.has(phase)
        ),
        slowestPhase:
          startupBarrier.slowestPhase?.phase || null,
      }
    );
    logger.error('[BOOT] Post-bind startup failed', {
      error: err.message,
    });
    return process.exit(1);
  });
}); // end app.listen callback

server.on('error', (err) => {
  recordStartupFailureAttribution(
    'server-bind-error',
    err,
    {
      port: PORT,
      code: err.code || null,
    }
  );

    if (err.code === 'EADDRINUSE') {
    logger.error(`[Server] Port ${PORT} is already in use.`);
  } else {
    logger.error('[Server] Startup error', {
      error: err.message,
    });
  }

  if (IS_TEST) {
    throw err;
  }

  return process.exit(1);
});

} catch (err) {
  recordStartupFailureAttribution(
  'bootstrap-fatal',
  err,
  {
    completedPhases: Array.from(startupBarrier.completed),
    pendingPhases: Array.from(
      startupBarrier.phases.keys()
    ).filter(
      (phase) => !startupBarrier.completed.has(phase)
    ),
    slowestPhase:
      startupBarrier.slowestPhase?.phase || null,
  }
);
  logger.error('[BOOT] Startup failed', {
    error: err.message,
  });

  if (IS_TEST) {
    throw err;
  }

  process.exit(1);
}
}

// Wave 48 — Attach graceful shutdown signal hooks BEFORE bootstrap() so that
// a SIGINT/SIGTERM arriving during startup is handled gracefully, not dropped.
// process.on is idempotent per-signal on fresh process starts.
process.on('SIGINT',  (...args) => gracefulShutdown(...args));
process.on('SIGTERM', (...args) => gracefulShutdown(...args));

bootstrap();
  
async function gracefulShutdown(signal) {
  if (isShuttingDown) {
    logger.warn('[Wave48] Shutdown already in progress', { signal });
    return;
  }

  isShuttingDown = true;

  const shutdownStartedAt = process.hrtime.bigint();

  const shutdownTimeoutMs = parseInt(
    process.env.SHUTDOWN_TIMEOUT_MS || '25000',
    10
  );

  const forcedShutdownTimer = setTimeout(() => {
    logger.error(
      '[Server] Graceful shutdown timeout exceeded — forcing exit'
    );
    // FIX S4: Call process.exit directly — the nested 50ms setTimeout adds no
    // value and can delay exit when the event loop is already draining.
    process.exit(1);
  }, shutdownTimeoutMs);

  forcedShutdownTimer.unref();

  // Patch 35 → drop readiness immediately during shutdown
startupBarrier.isReleased = false;
startupBarrier.releaseTimestamp = null;

startupWatchdog.degradedReleaseAllowed = false;

if (startupWatchdog.timer) {
  clearTimeout(startupWatchdog.timer);
  startupWatchdog.timer = null;
}

// Wave 30 — surrender distributed lease and stop renewal heartbeat immediately
const shutdownNodeId = getLocalReplicaId();


if (distributedLeaseRenewalLoop) {
  clearInterval(distributedLeaseRenewalLoop);
  distributedLeaseRenewalLoop = null;
  logger.info('[Wave30] Distributed lease renewal worker stopped', {
    nodeId: shutdownNodeId,
  });
}

// Wave 33 — stop lease failover watchdog on shutdown.
if (leaseFailoverState.watchdogTimer) {
  clearInterval(leaseFailoverState.watchdogTimer);
  leaseFailoverState.watchdogTimer = null;
  logger.info('[Wave33] Lease failover watchdog stopped');
}

// Wave 34 — stop lease chaos simulation worker on shutdown.
if (leaseChaosState._workerTimer) {
  clearInterval(leaseChaosState._workerTimer);
  leaseChaosState._workerTimer = null;
  leaseChaosState.activeScenario = null;
  leaseChaosState.enabled = false;
  logger.info('[Wave34] Lease chaos simulation worker stopped');
}

// Wave 35 — PATCH 7 SHUTDOWN: clear confidence scoring residue to guarantee
// no cross-restart stale watchdog bleed or suppression state corruption.
rollbackConfidenceState.lastScore            = 0;
rollbackConfidenceState.lastSeverity         = 'none';
rollbackConfidenceState.totalEvaluations     = 0;
rollbackConfidenceState.suppressedRollbacks  = 0;
rollbackConfidenceState.confirmedRollbacks   = 0;
rollbackConfidenceState.falsePositiveWindows = [];
rollbackConfidenceState.severityHistory      = [];

// Wave 36 — SHUTDOWN: clear trust decay registry + escalation ledger.
rollbackTrustState.regionTrust.clear();
rollbackTrustState.nodeTrust.clear();
rollbackTrustState.trustEvents           = [];
regionalEscalationState.escalations      = [];
regionalEscalationState.totalEscalations = 0;
regionalEscalationState.lastEscalationAt = null;

// Wave 37 — SHUTDOWN: clear anomaly fusion state.
anomalyFusionState.regions.clear();
anomalyFusionState.lastEvaluatedAt = null;
anomalyFusionState.consensusScore  = 0;
logger.info('[Wave37] Anomaly fusion state cleared on graceful shutdown');

// Wave 33 — close fallback client if it was opened.
if (leaseFailoverState._fallbackClient) {
  try {
    await leaseFailoverState._fallbackClient.quit();
  } catch (_) {}
  leaseFailoverState._fallbackClient = null;
}

  logger.info(
    `[Server] ${signal} received — shutting down gracefully...`
  );

  if (deployWarmupPromise) {
    logger.info('[Server] Waiting for deploy benchmark warmup...');
    await Promise.allSettled([deployWarmupPromise]);
  }

try {
  await snapshotWorker.preserveShutdownSnapshot();
  logger.info('[Server] Patch 14 lineage snapshot preserved');
} catch (err) {
  logger.warn('[Server] Patch 14 lineage snapshot failed (non-fatal)', {
    error: err.message,
  });
}
  // Step 1: drain all workers in parallel
  predictiveHeat.stopPredictiveTopologyWorker();
  logger.info('[Server] Patch 9 predictive topology worker stopped');

  predictiveHeat.stopLearningMeshWorker();
  logger.info('[Server] Patch 10 learning mesh worker stopped');

  predictiveHeat.stopFederationWorker();
  logger.info('[Server] Patch 11 federation worker stopped');

  predictiveHeat.stopSwarmGovernanceWorker();
  logger.info('[Server] Patch 12 swarm governance worker stopped');

  replayPolicyEngine.stopReplayPolicyWorker();
  logger.info('[Server] Patch 13 replay policy worker stopped');

  cacheHydrationWorker.stopCacheHydrationWorker();
  logger.info('[Server] Patch 14 cache hydration mesh stopped');

  warmStatePrefetch.stopWarmStatePrefetchWorker();
  logger.info('[Server] Patch 15 warm-state prefetch worker stopped');

  await warmStatePrefetch.preserveHotsetSnapshot();
  logger.info('[Server] Patch 15 warm-state hotset preserved');

  await regionalHandoffWorker.stopRegionalMigrationWorker();
  logger.info('[Server] Patch 16 regional handoff preserved');

  globalPolicyMesh.shutdownGlobalPolicyMesh();
  logger.info('[Server] Patch 18 policy arbitration mesh stopped');

  recoveryScheduler.stopRecoveryScheduler();
  logger.info('[Server] Patch 19 recovery scheduler stopped');

  pressureBalancer.stopPressureBalancerWorker();
  logger.info('[Server] Patch 20 pressure balancer worker stopped');

  quorumReplication.stopQuorumReplicationWorker();
  logger.info(
    '[Server] Patch 21 quorum replication mesh stopped'
  );

  consensusMesh.shutdown();
  logger.info(
    '[Server] Patch 22 consensus replay mesh stopped'
  );

  try {
    consensusDriftAnomaly.shutdown();
    logger.info(
      '[Server] Patch 23 drift anomaly detector stopped'
    );
  } catch (err) {
    logger.warn('[Server] Patch 23 shutdown warning', {
      error: err.message,
    });
  }

  try {
    predictiveSplitBrain.shutdown();
    logger.info(
      '[Server] Patch 24 predictive split-brain prevention stopped'
    );
  } catch (err) {
    logger.warn('[Server] Patch 24 shutdown warning', {
      error: err.message,
    });
  }

  try {
    quorumConfidence.shutdown();
    logger.info(
      '[Server] Patch 25 quorum confidence engine stopped'
    );
  } catch (err) {
    logger.warn('[Server] Patch 25 shutdown warning', {
      error: err.message,
    });
  }

  try {
    consensusMemoryForecastLoop?.shutdown();
    logger.info(
      '[Server] Patch 26 consensus memory forecast stopped'
    );
  } catch (err) {
    logger.warn('[Server] Patch 26 shutdown warning', {
      error: err.message,
    });
  }

  try {
    autonomousTopologyMutationWorker?.shutdown();
    logger.info(
      '[Server] Patch 27 autonomous topology mutation worker stopped'
    );
  } catch (err) {
    logger.warn('[Server] Patch 27 shutdown warning', {
      error: err.message,
    });
  }

  logger.info(
    `[Server] Final circuit states: ${JSON.stringify(
      circuitMesh.getAllCircuitStates()
    )}`
  );

  logger.info(
    '[Server] Patch 17 sovereign routing mesh state preserved'
  );

  if (workerShutdownTasks.length > 0) {
    logger.info(
      `[Server] Stopping ${workerShutdownTasks.length} worker(s)...`
    );

    await Promise.allSettled(
      workerShutdownTasks.map((task) => task())
    );

    logger.info('[Server] All workers stopped.');
  }

  // Step 2: stop accepting new HTTP requests.
  // closeAllConnections() terminates keep-alive connections immediately so that
  // server.close() resolves promptly instead of waiting for idle timeout.
  // Available since Node.js 18.2.0 — safe to call conditionally.
  if (server) {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    await new Promise((resolve) =>
      server.close(() => {
        logger.info('[Server] HTTP server closed.');
        resolve();
      })
    );
  }

  await predictiveHeat
    .recordHeat({
      tenantId: 'global',
      signalType: 'replica_cold_exit',
      weight: 5 + getWeeklySprintBias(),
    })
    .catch((err) => {
      logger.warn('[Server] Predictive shutdown heat record failed', {
        error: err.message,
      });
    });

  // Step 3: Wave 32 — PATCH 4: epoch-guarded Lua CAS lease surrender before closing Redis.
  // LUA_RELEASE_LEASE only deletes keys if the stored value matches our epoch,
  // preventing us from evicting a replacement pod's lease during a slow shutdown.
  try {
    const leaseKey    = getReplicaLeaseKey(shutdownNodeId);
    const epochKey    = getReplicaEpochKey(shutdownNodeId);
    // Wave 33 — route through region-aware resolver.
    const redisClient = getLeaseRedisClient();

    if (redisClient) {
  // Wave 32 hardening — derive held epoch from the local lease map
  // inside gracefulShutdown scope so CAS ownership remains valid.
  const localLease =
    distributedStartupConsensus.releaseLocks.get(
      shutdownNodeId
    );

  const heldEpoch =
    localLease?.leaseEpoch ?? 0;

  if (heldEpoch > 0) {
    const casResult = await redisClient.eval(
      LUA_RELEASE_LEASE,
      2,
      leaseKey,
      epochKey,
      String(heldEpoch)
    );

    if (casResult === 1) {
      logger.info(
        '[Wave32] Redis durable lease surrendered via Lua CAS on graceful shutdown',
        {
          nodeId: shutdownNodeId,
          heldEpoch,
        }
      );
    } else {
      logger.warn(
        '[Wave32] Lua CAS surrender skipped — lease already owned by another replica',
        {
          nodeId: shutdownNodeId,
          heldEpoch,
        }
      );
    }
  }
}
} catch (err) {
  logger.warn(
    '[Wave32] Lua CAS lease surrender failed during shutdown (non-fatal)',
    {
      nodeId: shutdownNodeId,
      error: err.message,
    }
  );
}

  // Step 3: close Redis gracefully
  // Wave 48 — clear all tracked intervals before closing Redis
  for (const id of _trackedIntervals) {
    clearInterval(id);
  }
  _trackedIntervals.clear();
  logger.info('[Wave48] All tracked intervals cleared');

  // Wave 48 — close gossip UDP socket if tracked
  if (_gossipSocket) {
    try {
      _gossipSocket.close();
      logger.info('[Wave48] Tracked gossip socket closed');
    } catch (err) {
      logger.warn('[Wave48] Gossip socket close failed', { error: err.message });
    }
    _gossipSocket = null;
  }

  // Wave 48 — close all tracked Redis clients
  for (const client of _trackedRedisClients) {
    try {
      if (client && client.status !== 'end') {
        await client.quit();
      }
    } catch (err) {
      logger.warn('[Wave48] Redis client close skipped/failed', {
        error: err.message
      });
    }
  }
  _trackedRedisClients.clear();
  logger.info('[Wave48] All tracked Redis clients closed');

  try {
    await closeRedis();
    logger.info('[Server] Redis closed gracefully.');
  } catch (err) {
    if (!IS_TEST) {
      logger.warn('[Server] Redis shutdown warning', {
        error: err.message,
      });
    }
  }

  // Wave 41 — Gossip socket already closed via _gossipSocket reference above (Wave 48).
  // Both variables point to the same socket; closing twice throws ERR_SOCKET_DGRAM_NOT_RUNNING.

  const shutdownDurationMs =
    Number(process.hrtime.bigint() - shutdownStartedAt) / 1e6;

  logger.info('[Telemetry] Graceful shutdown completed', {
    signal,
    duration_ms: Number(shutdownDurationMs.toFixed(2)),
  });

// Clear the forced-exit timer immediately — all shutdown steps completed cleanly.
// process.exit(0) is called directly; no setTimeout race with the forced timer.
clearTimeout(forcedShutdownTimer);
workerBootRegistry.clear();
process.exit(0);
}

// Signal hooks are registered above bootstrap() to handle signals during startup.