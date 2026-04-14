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
 */

'use strict';

// ── Environment validation — MUST be first ────────────────────────────────────
// Validates all required environment variables before anything else loads.
// Server will not start if required variables are missing or malformed.
require('dotenv').config();
require('./config/env');

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
const aiUsage = require('./services/aiUsage.service');
const quorumReplication = require('./services/cache/quorumReplication.service');
const consensusMesh = require('./services/cache/replayConsensusMesh.service');
const consensusDriftAnomaly = require('./services/cache/consensusDriftAnomaly.service');
const predictiveSplitBrain = require('./services/cache/predictiveSplitBrain.service');
const quorumConfidence = require('./services/cache/quorumConfidence.service');
const consensusMemoryForecast = require('./services/cache/consensusMemoryForecast.service');
const autonomousTopologyMutation = require('./services/cache/autonomousTopologyMutation.service');

// ── Middleware ────────────────────────────────────────────────────────────────
const { errorHandler, notFoundHandler }   = require('./middleware/errorHandler');
const { correlationMiddleware }           = require('./middleware/correlation.middleware');
const { requestTimeout } = require('./middleware/requestTimeout.middleware');
const { authenticate, requireAdmin }      = require('./middleware/auth.middleware');
const { requireMasterAdmin }              = require('./middleware/requireMasterAdmin.middleware');
const { requireContributor }              = require('./middleware/requireContributor.middleware');
const { adminRateLimit, masterRateLimit } = require('./middleware/adminRateLimit.middleware');
const { requireInternalToken }            = require('./middleware/internalToken.middleware');
const {
  tenantRegionMiddleware,
} = require('./middleware/tenantRegion.middleware');
// ── Route modules ─────────────────────────────────────────────────────────────
const devRoutes            = require('./modules/dev/dev.routes');
const { secretsRouter }    = require('./modules/secrets');
const marketIntelRouter    = require('./modules/marketIntelligence/marketIntelligence.routes');
const { skillDemandRouter } = require('./modules/skillDemand');
const directionRouter      = require('./routes/userDirection.routes');

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

// Tracks which workers have been booted to prevent duplicate starts on
// hot-reload / nodemon restarts.
const workerBootRegistry = new Set();

// Distributed startup barrier — readiness gate for /api/v1/ready.
// All required phases must complete before traffic is accepted.
const startupBarrier = {
  phases: new Map(),
  completed: new Set(),
  phaseDurations: new Map(),
  slowestPhase: null,
  isReleased: false,
  releaseTimestamp: null,
};

const startupRegressionProfiler = {
  repeatedSlowPhase: new Map(),
  lastBootSlowestPhase: null,
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
const ROUTE_LEADERBOARD_INTERVAL_MS = 15000;
// Patch 38 → startup phase failure attribution registry
const startupPhaseAttribution = {
  phases: new Map(),
  failures: [],
  lastRootCause: null,
};

function markStartupPhase(phase, metadata = {}) {
  startupPhaseAttribution.phases.set(phase, {
    phase,
    startedAt: Date.now(),
    ...metadata,
  });
}

const routeLeaderboardInterval = setInterval(() => {
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
  startupPhaseAttribution.lastRootCause = failure;

  return failure;
}

function releaseDegradedStartupBarrier(
  reason = 'startup-timeout'
) {
  if (startupBarrier.isReleased) {
    return;
  }

  startupWatchdog.degradedReleaseAllowed = true;
  startupChaosConfidence.degradedReleases += 1;
  startupChaosConfidence.rollbackRiskScore += 15;
  startupBarrier.isReleased = true;
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
function registerStartupPhase(phase) {
  const registeredAt = Date.now();

  startupBarrier.phases.set(phase, {
    registeredAt,
    status: 'pending',
  });

  markStartupPhase(phase, {
    registeredAt,
    status: 'pending',
  });
}

/**
 * Mark a named startup phase as complete and attempt to release the barrier.
 */
function completeStartupPhase(phase) {
  startupBarrier.completed.add(phase);

  const existing = startupBarrier.phases.get(phase) || {};
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

  const attributionExisting =
    startupPhaseAttribution.phases.get(phase) || {};

  startupPhaseAttribution.phases.set(phase, {
    ...attributionExisting,
    phase,
    completedAt,
    durationMs,
    status: 'completed',
  });

  if (durationMs !== null) {
    startupBarrier.phaseDurations.set(phase, durationMs);

    if (
      !startupBarrier.slowestPhase ||
      durationMs > startupBarrier.slowestPhase.durationMs
    ) {
      startupBarrier.slowestPhase = {
        phase,
        durationMs,
      };
    }
  }

  tryReleaseStartupBarrier();
}

function tryReleaseStartupBarrier() {
  if (startupBarrier.isReleased) {
    return true;
  }

  const requiredPhases = [
    'redis-connect',
    'supabase-bootstrap-verification',
    'http-server-bind',
    'predictive-topology-worker',
    'cache-hydration',
    'global-policy-mesh',
    'pressure-balancer',
    'quorum-replication',
  ];

  const ready = requiredPhases.every((phase) =>
    startupBarrier.completed.has(phase)
  );

  if (!ready) {
    return false;
  }

  startupBarrier.isReleased = true;
  startupBarrier.releaseTimestamp = Date.now();

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
        ? `router_${lastHandler.stack.length}`
        : `handler_${handlers.length}`;

  const signature = `${path}::${handlerKey}`;

  if (registeredRouteKeys.has(signature)) {
    logger.warn('[Server] Duplicate route registration prevented', {
      path,
      handlerKey,
    });
    return;
  }

  registeredRouteKeys.add(signature);
  app.use(path, ...handlers);
}

function logRouteRegistrySummary() {
  logger.info('[Server] Route registry initialized', {
    total_registered_routes: registeredRouteKeys.size,
  });
}
// Trust proxy — safe for Cloud Run / GCP Load Balancer.
// '1' means trust exactly one proxy hop; do not use 'true' (trusts all).
app.set('trust proxy', 1);

// =============================================================================
// CORS configuration
// =============================================================================
// Domain-driven — no hardcoded origins.
// Set MAIN_DOMAIN, ADMIN_DOMAIN, ALLOWED_ORIGINS in .env.
const MAIN_DOMAIN  = process.env.MAIN_DOMAIN  || 'hirerise.com';
const ADMIN_DOMAIN = process.env.ADMIN_DOMAIN || `admin.${MAIN_DOMAIN}`;

const allowedOrigins = [
  ...(process.env.ALLOWED_ORIGINS || 'http://localhost:3001')
    .split(',').map(o => o.trim()),
  ...(process.env.NODE_ENV !== 'test' ? [
    `https://${MAIN_DOMAIN}`,
    `https://${ADMIN_DOMAIN}`,
    `https://www.${MAIN_DOMAIN}`,
  ] : []),
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
    if (!origin) return callback(null, true);
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
  req.route?.path ||
  req.path ||
  req.originalUrl
}`;

if (!routeLatencyBuckets.has(routeKey)) {
  routeLatencyBuckets.set(routeKey, []);
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
if (process.env.NODE_ENV !== 'test') {
  app.use(
    morgan(
      process.env.NODE_ENV === 'production' ? 'combined' : 'dev',
      {
        stream: {
          write: (msg) => logger.http(msg.trim()),
        },
      }
    )
  );
}

// ── API prefix ────────────────────────────────────────────────────────────────
// Hardcoded — must never be overridden via env.
const API_PREFIX = '/api/v1';

// ── Dev routes — non-production only ─────────────────────────────────────────
if (process.env.NODE_ENV !== 'production') {
  app.use(`${API_PREFIX}/dev`, devRoutes);
}

// ── Global rate limiter ───────────────────────────────────────────────────────
// Keyed by authenticated UID when available; falls back to IP for anonymous
// requests (webhooks, health). IP-only limiting is trivially bypassed behind
// a CDN and is unfair in NAT environments.
const globalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS    || '900000', 10),
  max:      parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '400',    10),
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator:    (req) => req.user?.uid || req.ip,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many requests. Please retry later.' },
  },
});
app.use(globalLimiter);

// =============================================================================
//// =============================================================================
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

app.get(`${API_PREFIX}/ready`, async (_req, res) => {
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
    database.latency_ms = Number(
      dbDurationMs.toFixed(2)
    );
  } catch (err) {
    logger.warn('[Server] Ready probe DB check failed', {
      error: err.message,
    });
  }

  const ok =
    redis.connected &&
    database.connected &&
    startupBarrier.isReleased;

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
app.get(`${API_PREFIX}/metrics`, observabilityAdapter.prometheusMetricsHandler());

// =============================================================================
// ✅ Protected Route Modules (authenticate applied per route group)
// =============================================================================
// Auth applied per-group intentionally: avoids the 401-before-404 ordering bug
// that occurs when a global authenticate() precedes all routes.

registerRoute(
  `${API_PREFIX}/career`,
  authenticate,
  tenantRegionMiddleware,
  require('./routes/career.routes')
);

registerRoute(
  `${API_PREFIX}/career`,
  authenticate,
  engagementRouter
);

registerRoute(
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

app.use(`${API_PREFIX}/admin/graph`,               authenticate, requireAdmin, require('./modules/admin/graph/graphAdmin.routes'));
app.use(`${API_PREFIX}/admin/graph-intelligence`,  authenticate, requireAdmin, require('./modules/admin/graph/graphIntelligence.routes'));
app.use(`${API_PREFIX}/admin/platform-intelligence`, authenticate, requireAdmin, require('./modules/platform-intelligence/routes/platformIntelligence.routes'));

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
app.use(`${API_PREFIX}/career-onboarding`,  authenticate, require('./routes/career-onboarding.routes'));

/**
 * Job Seeker Intelligence
 *   GET /api/v1/job-seeker/skills/user-graph     → personalised skill graph
 *   GET /api/v1/job-seeker/skills/skill-gap      → skill gap vs market demand
 *   GET /api/v1/job-seeker/jobs/match            → top matched roles (scored)
 *   GET /api/v1/job-seeker/jobs/recommendations  → enriched top-5 recommendations
 */

/**
 * Semantic AI Upgrade — Skill Intelligence + Job Matching
 * Controlled by FEATURE_SEMANTIC_MATCHING=true env flag.
 *
 *   GET  /api/v1/skills/similar           → semantically similar skills (cosine sim)
 *   POST /api/v1/skills/embed             → generate/store skill embedding
 *   GET  /api/v1/job-seeker/jobs/semantic-match → vector-based job matching
 *   GET  /api/v1/career/advice            → AI career advisor (grounded)
 *   GET  /api/v1/skills/learning-path     → AI-generated learning paths
 */
/**
 * Semantic AI — Skill Intelligence + Job Matching (mounted on API_PREFIX directly)
 *   GET  /api/v1/skills/similar                    → semantically similar skills (cosine sim)
 *   POST /api/v1/skills/embed                      → generate/store skill embedding
 *   GET  /api/v1/job-seeker/jobs/semantic-match    → vector-based job matching
 *   GET  /api/v1/career/advice                     → AI career advisor (grounded)
 *   GET  /api/v1/skills/learning-path              → AI-generated learning paths
 * Controlled by FEATURE_SEMANTIC_MATCHING=true env flag.
 */
app.use(API_PREFIX, authenticate, require('./routes/semantic.routes'));

/**
 * AI Career Opportunity Radar
 *   GET  /api/v1/career/opportunity-radar         → personalised emerging opportunities
 *   GET  /api/v1/career/emerging-roles            → public catalogue of emerging roles
 *   POST /api/v1/career/opportunity-radar/refresh → admin: refresh signals from LMI
 */
/**
 * AI Career Opportunity Radar (mounted on API_PREFIX directly)
 *   GET  /api/v1/career/opportunity-radar          → personalised emerging opportunities
 *   GET  /api/v1/career/emerging-roles             → public catalogue of emerging roles
 *   POST /api/v1/career/opportunity-radar/refresh  → admin: refresh signals from LMI
 */
app.use(API_PREFIX, authenticate, require('./modules/opportunityRadar/opportunityRadar.routes'));

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
if (process.env.FEATURE_EVENT_BUS === 'true') {
  app.use(API_PREFIX, authenticate, require('./modules/ai-event-bus/routes/aiEventBus.routes'));
}

/**
 * AI Personalization Engine
 *   POST /api/v1/user/behavior-event                   → track user interaction
 *   GET  /api/v1/career/personalized-recommendations   → personalized career list
 *   GET  /api/v1/user/personalization-profile          → current signal profile
 *   POST /api/v1/user/update-behavior-profile          → manual profile refresh
 */
/**
 * AI Personalization Engine (mounted on API_PREFIX directly)
 *   POST /api/v1/user/behavior-event                  → track user interaction
 *   GET  /api/v1/career/personalized-recommendations  → personalized career list
 *   GET  /api/v1/user/personalization-profile         → current signal profile
 *   POST /api/v1/user/update-behavior-profile         → manual profile refresh
 */
app.use(API_PREFIX, authenticate, require('./modules/personalization/personalization.routes'));

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

app.use(
  `${API_PREFIX}/advisor`,
  authenticate,
  tenantRegionMiddleware,
  require('./modules/ai-career-advisor/routes/advisor.routes')
);

registerRoute(
  `${API_PREFIX}/copilot`,
  authenticate,
  tenantRegionMiddleware,
  require('./modules/career-copilot/routes/careerCopilot.routes')
);

registerRoute(
  `${API_PREFIX}/copilot`,
  authenticate,
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
app.use(`${API_PREFIX}/user-activity`, require('./modules/userActivity/userActivity.routes'));

app.use(`${API_PREFIX}/job-analyses`,   authenticate, require('./routes/jobAnalyzer.routes'));
app.use(`${API_PREFIX}/cv-builder`,     authenticate, require('./routes/cvBuilder.routes'));

registerRoute(
  `${API_PREFIX}/users`,
  authenticate,
  require('./routes/users.routes')
);

registerRoute(
  `${API_PREFIX}/users`,
  authenticate,
  directionRouter
);

app.use(`${API_PREFIX}/analyze`,  authenticate, require('./modules/analysis/analysis.route'));

// Phase 2: async AI job status poll
app.use(`${API_PREFIX}/ai-jobs`,  authenticate, require('./routes/aiJobs.route'));

app.use(`${API_PREFIX}/roles`,         authenticate, require('./modules/roles/roles.routes'));
app.use(`${API_PREFIX}/applications`,  authenticate, require('./jobApplications/jobApplications.routes'));
app.use(`${API_PREFIX}/cover-letter`,  authenticate, require('./modules/coverLetter/coverLetter.routes'));
app.use(`${API_PREFIX}/dashboard`,     authenticate, require('./modules/dashboard/dashboard.route'));
app.use(`${API_PREFIX}/app-entry`,     authenticate, require('./modules/appEntry/appEntry.route'));
app.use(`${API_PREFIX}/qualifications`, authenticate, require('./modules/qualification/qualification.routes'));

// =============================================================================
// ✅ Admin Routes (authenticate + requireAdmin)
// =============================================================================
// requireAdmin checks decoded.admin === true OR decoded.role === 'admin'|'super_admin'
// These claims are set on the Supabase user JWT via app_metadata.
// Rate limit: 50 req/min per user (adminRateLimit).
app.use(`${API_PREFIX}/admin`, adminRateLimit);

app.use(`${API_PREFIX}/admin/metrics`,           authenticate, requireAdmin, require('./routes/admin/adminMetrics.routes'));
app.use(`${API_PREFIX}/admin/ai`,                authenticate, requireAdmin, require('./routes/admin/ai-observability.routes'));
app.use(`${API_PREFIX}/admin/jobs`,              authenticate, requireAdmin, require('./modules/admin/jobs/adminJobs.routes'));
app.use(`${API_PREFIX}/admin/adaptive-weights`,  authenticate, requireAdmin, require('./modules/adaptiveWeight/adaptiveWeight.routes'));

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
app.use(`${API_PREFIX}/admin/cms/skills`,      authenticate, requireAdmin, require('./modules/admin/cms/skills/adminCmsSkills.routes'));
app.use(`${API_PREFIX}/admin/cms/roles`,       authenticate, requireAdmin, require('./modules/admin/cms/roles/adminCmsRoles.routes'));
app.use(`${API_PREFIX}/admin/cms/career-domains`,   authenticate, requireAdmin, careerDomainsModule.router);
app.use(`${API_PREFIX}/admin/cms/skill-clusters`,   authenticate, requireAdmin, skillClustersModule.router);
app.use(`${API_PREFIX}/admin/cms/job-families`,     authenticate, requireAdmin, jobFamiliesModule.router);
app.use(`${API_PREFIX}/admin/cms/education-levels`, authenticate, requireAdmin, educationLevelsModule.router);
app.use(`${API_PREFIX}/admin/cms/salary-benchmarks`, authenticate, requireAdmin, salaryBenchmarksModule.router);
app.use(`${API_PREFIX}/admin/cms/import`,      authenticate, requireAdmin, require('./modules/admin/cms/import/adminCmsImport.routes'));

/**
 * Admin CSV File Upload Import (authenticate + requireAdmin)
 *   POST /api/v1/admin/cms/import/csv/:datasetType
 *   Supported: skills | roles | jobFamilies | educationLevels
 */
app.use(`${API_PREFIX}/admin/cms/import/csv`, authenticate, requireAdmin, require('./modules/admin/import/import.routes'));

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
app.use(`${API_PREFIX}/admin/contributors`, authenticate, requireAdmin, require('./routes/admin/adminContributors.routes'));

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
app.use(`${API_PREFIX}/admin/import`, authenticate, requireAdmin, require('./modules/admin/import/adminImport.routes'));

/**
 * CSV Salary Bulk Import (authenticate + requireAdmin)
 *   POST /api/v1/admin/import/salaries
 *   Content-Type: multipart/form-data, field: file (CSV, max 10MB)
 *   Flow: multer → streaming csv-parser → role normalization → validate → batch Supabase write
 *   Returns HTTP 207 on partial success (some rows skipped/errored).
 */
app.use(`${API_PREFIX}/admin/import/salaries`, authenticate, requireAdmin, require('./modules/salaryImport/salaryImport.routes'));

/**
 * Role Alias Management (authenticate + requireAdmin)
 *   POST /api/v1/admin/cms/role-aliases          → create alias
 *   GET  /api/v1/admin/cms/role-aliases/:roleId  → list aliases for a role
 *
 * Used by CSV import + sync worker to normalize role names from external sources.
 */
app.use(`${API_PREFIX}/admin/cms/role-aliases`, authenticate, requireAdmin, require('./modules/roleAliases/roleAlias.routes'));

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
// ✅ Terminal handlers — must be last
// =============================================================================
app.use(notFoundHandler);
app.use(errorHandler);

// =============================================================================
// ✅ Startup tasks (non-blocking — server is already listening)
// =============================================================================
const {
  warmHotTenantsOnDeploy,
} = require('./workers/lifecycle.worker');

const {
  replayDeployConsensus,
} = require('./workers/lifecycleHeat.worker');

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
if (process.env.GOTENBERG_URL && process.env.NODE_ENV !== 'test') {
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
  const now = new Date();
  const isMonday = now.getDay() === 1;
  const hour = now.getHours();

  if (!isMonday) return 0;
  if (hour >= 8 && hour <= 12) return 10;

  return 0;
}

async function bootstrap() {
  try {
   
    // Patch 35 → register distributed startup phases
[
  'redis-connect',
  'supabase-bootstrap-verification',
  'http-server-bind',
  'deploy-warmup',
  'predictive-topology-worker',
  'learning-mesh-worker',
  'federation-worker',
  'swarm-governance-worker',
  'cache-hydration',
  'warm-state-prefetch',
  'global-policy-mesh',
  'recovery-scheduler',
  'pressure-balancer',
  'quorum-replication',
  'consensus-memory-forecast',
  'autonomous-topology-mutation',
  'sovereign-routing',
].forEach(registerStartupPhase);

startupWatchdog.degradedReleaseAllowed = false;
startupWatchdog.startedAt = Date.now();

startupWatchdog.timer = setTimeout(() => {
  releaseDegradedStartupBarrier('startup-sla-timeout');
}, startupWatchdog.timeoutMs);

 // PR 2: Redis must be ready before serving traffic
    await connectRedis();
    completeStartupPhase('redis-connect');

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

if (process.env.NODE_ENV === 'test') {
  return;
}

  server = app.listen(PORT, () => {
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
      activeTenants: global.__ACTIVE_TENANTS__ || [],
      warmFn: async (tenantId, meta) => {
        if (global.benchmarkQueue?.enqueueTenantWarm) {
          await global.benchmarkQueue.enqueueTenantWarm({
            tenantId,
            source: meta.source,
            confidence: meta.confidence,
          });
        }
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
logger.info('[Server] Patch 13 replay policy worker started');

cacheHydrationWorker.startCacheHydrationWorker();
completeStartupPhase('cache-hydration');

logger.info('[Server] Patch 14 cache hydration mesh started');

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

global.__tenantCacheMesh =
  global.__tenantCacheMesh || new Map();

quorumReplication.startQuorumReplicationWorker(
  () => global.__tenantCacheMesh
);

completeStartupPhase('quorum-replication');

logger.info(
  '[Server] Patch 21 quorum replication mesh started'
);

logger.info(
  '[Server] Patch 22 consensus replay mesh initialized'
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
  '[Server] Patch 27 autonomous topology mutation worker started'
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

    startupChaosConfidence.confidenceScore = Math.max(
      0,
      100 -
        startupChaosConfidence.rollbackRiskScore
    );

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

  if (process.env.NODE_ENV === 'test') {
    throw err;
  }

  process.exit(1);
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

  if (process.env.NODE_ENV === 'test') {
    throw err;
  }

  process.exit(1);
}
}

bootstrap();
  
// Consolidated Graceful Shutdown
const gracefulShutdown = async (signal) => {
  const shutdownStartedAt = process.hrtime.bigint();

  if (isShuttingDown) {
    logger.warn('[Server] Duplicate shutdown signal ignored', {
      signal,
    });
    return;
  }

  isShuttingDown = true;

  // Patch 35 → drop readiness immediately during shutdown
startupBarrier.isReleased = false;
startupBarrier.releaseTimestamp = null;

startupWatchdog.degradedReleaseAllowed = false;

if (startupWatchdog.timer) {
  clearTimeout(startupWatchdog.timer);
  startupWatchdog.timer = null;
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

  // Step 2: stop accepting new HTTP requests
  if (server) {
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

  // Step 3: close Redis gracefully
  try {
    await closeRedis();
    logger.info('[Server] Redis closed gracefully.');
  } catch (err) {
    if (process.env.NODE_ENV !== 'test') {
      logger.warn('[Server] Redis shutdown warning', {
        error: err.message,
      });
    }
  }

  const shutdownDurationMs =
    Number(process.hrtime.bigint() - shutdownStartedAt) / 1e6;

  logger.info('[Telemetry] Graceful shutdown completed', {
    signal,
    duration_ms: Number(shutdownDurationMs.toFixed(2)),
  });

  workerBootRegistry.clear();
  process.exit(0);
};