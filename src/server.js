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
  startupBarrier.pendingDistributedRelease = true;
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

  distributedLeaseRenewalLoop = setInterval(() => {
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
  lastPersistedEpochAt: null,

  // Safety threshold before hard local rollback
  maxDriftToleranceMs: parseInt(
    process.env.LEASE_MAX_REGION_DRIFT_MS || '5000',
    10
  ),

  // Internal handle — populated by startLeaseChaosSimulationWorker()
  _workerTimer: null,
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

  leaseFailoverState.watchdogTimer = setInterval(async () => {
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
        logger.info('[Wave33] Lease Redis failback completed — primary region restored', {
          primaryRegion:  leaseFailoverState.primaryRegion,
          recoveries:     leaseFailoverState.consecutiveRecoveries,
        });
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

  if (driftResult.rollbackRequired) {
    logger.warn(
      '[Wave34] Lease region drift exceeded tolerance — executing local safety rollback',
      {
        nodeId: getLocalReplicaId(),
        deltaMs: driftResult.deltaMs,
        localEpoch:
          driftResult.localEpoch ?? null,
        persistedEpoch:
          driftResult.persistedEpoch ?? null,
      }
    );

    await rollbackLeaseRegionDrift(
      getLocalReplicaId()
    );
  }
}
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

  leaseChaosState._workerTimer = setInterval(() => {
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
        }
        break;

      case 'delayed-primary-recovery':
        // Simulate a slow primary return — push toward failback threshold
        leaseFailoverState.consecutiveRecoveries += 1;
        leaseFailoverState.consecutiveFailures    = 0;
        leaseFailoverState.primaryRecoveries     += 1;
        break;

      case 'fallback-epoch-drift':
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
        }
        break;

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
      // Redis unavailable — soft-degrade to in-memory only.
      logger.warn('[Wave32] Lua acquire eval error — soft-degrading to in-memory lease', {
        nodeId, error: err.message,
      });
      casResult = 1; // treat as granted to avoid blocking startup
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
  logger.info('[Server] Route registry initialized', {
    total_guarded_route_mounts: registeredRouteKeys.size,
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
  localRedisLeasePresent: await (async () => {
    const state = await getRedisLeaseState(getLocalReplicaId());
    return state?.leaseExists ?? null;
  })(),
  // Wave 32 — Lua CAS telemetry fields
  luaCasEnabled: true,
  leaseOwnerEpoch: await (async () => {
    const state = await getRedisLeaseState(getLocalReplicaId());
    return state?.persistedEpoch ?? null;
  })(),
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
  leaseChaosRollbackEvents:   leaseChaosState.rollbackEvents,
  leaseChaosLastRollbackAt:   leaseChaosState.lastRollbackAt,
  leaseMaxRegionDriftMs:      leaseChaosState.maxDriftToleranceMs,
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

// Patch 48B Fix 3: agentCoordinator is an intentional second bounded-context
// router at /copilot. Uses app.use directly so it coexists with careerCopilot.routes
// without triggering the duplicate-guard fingerprint collision.
app.use(
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
  `${API_PREFIX}/user-direction`,
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
 // Wave 30.5 bootstrap lifecycle reset:
// clears route dedup state, startup DAG state,
// distributed leases, profiler lineage, and mutation overlays
// before authoritative DAG reconstruction.

   // Patch 35 → register distributed startup phases
startupBarrier.registrationComplete = false;
registeredRouteKeys.clear();
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

const shutdownNodeId = getLocalReplicaId();

const localHeldLease =
  distributedStartupConsensus.releaseLocks.get(
    shutdownNodeId
  );

const localHeldEpoch =
  localHeldLease?.leaseEpoch ?? 0;

// Wave 32 — PATCH 4 (updated): startup recovery via shared getRedisLeaseState helper.
// Before re-acquiring, check Redis for a persisted epoch so the Lua CAS epoch fence
// in tryReleaseStartupBarrier can detect fast pod restarts.
await (async () => {
  const state = await getRedisLeaseState(shutdownNodeId);

  if (state === null) {
    logger.info('[Wave32] Bootstrap Redis lease check skipped — Redis unavailable', {
      nodeId: shutdownNodeId,
    });
    return;
  }

  if (state.leaseExists && state.persistedEpoch !== null) {
    logger.info('[Wave32] Durable Redis epoch found during bootstrap recovery — fast restart detected', {
      nodeId:          shutdownNodeId,
      redisEpoch:      state.persistedEpoch,
      leaseKeyPresent: true,
    });
  } else {
    logger.info('[Wave32] No Redis lease found during bootstrap — fresh acquisition path', {
      nodeId: shutdownNodeId,
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

// Wave 33 — start lease failover watchdog immediately after Redis connects.
// Probes primary every probeIntervalMs; promotes fallback on threshold failures.
startLeaseFailoverWatchdog();

// Wave 34 — start lease chaos simulation worker after the watchdog.
// No-ops unless LEASE_CHAOS_MODE=true. Idempotent: duplicate start is blocked
// by internal _workerTimer guard inside startLeaseChaosSimulationWorker().
startLeaseChaosSimulationWorker();

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

server = app.listen(PORT, '0.0.0.0');
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
    process.exit(1);
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

  const shutdownTimeoutMs = parseInt(
    process.env.SHUTDOWN_TIMEOUT_MS || '25000',
    10
  );

  const forcedShutdownTimer = setTimeout(() => {
    logger.error(
      '[Server] Graceful shutdown timeout exceeded — forcing exit'
    );
    process.exit(1);
  }, shutdownTimeoutMs);

  forcedShutdownTimer.unref();

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

clearTimeout(forcedShutdownTimer);
workerBootRegistry.clear();
process.exit(0);
};