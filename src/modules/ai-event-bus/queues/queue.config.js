'use strict';

/**
 * queues/queue.config.js — BullMQ Queue Configuration
 *
 * Central registry for all AI pipeline queues.
 * Each engine gets its own named queue so failures are isolated
 * and concurrency can be tuned per engine independently.
 *
 * Architecture:
 *   AIEventBus.publish(event) → adds job to the correct queue(s)
 *   Worker processes queue    → runs engine → writes result to Supabase
 *
 * Queue naming convention:  hirerise:<engine>:queue
 *
 * BullMQ job options per queue are set here.
 * All queues share the same Redis connection (CACHE_PROVIDER=redis).
 *
 * @module src/modules/ai-event-bus/queues/queue.config
 */

// ─── Queue names ──────────────────────────────────────────────────────────────

const QUEUE_NAMES = Object.freeze({
  SKILL_GRAPH:       'hirerise:skill-graph:queue',
  CAREER_HEALTH:     'hirerise:career-health:queue',
  JOB_MATCHING:      'hirerise:job-matching:queue',
  RISK_ANALYSIS:     'hirerise:risk-analysis:queue',
  OPPORTUNITY_RADAR: 'hirerise:opportunity-radar:queue',
  CAREER_ADVISOR:    'hirerise:career-advisor:queue',
});

// ─── Default job options ──────────────────────────────────────────────────────

/**
 * Default BullMQ job options applied to every job added to any queue.
 * Individual queues can override these via QUEUE_OPTIONS below.
 */
const DEFAULT_JOB_OPTIONS = {
  attempts:   3,
  backoff: {
    type:  'exponential',
    delay: 2000,   // 2s → 4s → 8s
  },
  removeOnComplete: {
    age:   3600,   // keep completed jobs for 1 hour in BullMQ
    count: 100,    // keep last 100 completed jobs per queue
  },
  removeOnFail: {
    age:   86400,  // keep failed jobs for 24 hours for debugging
    count: 50,
  },
};

// ─── Per-queue options ────────────────────────────────────────────────────────

/**
 * Queue-specific options. Merged over DEFAULT_JOB_OPTIONS.
 * concurrency = how many jobs this worker processes simultaneously.
 */
const QUEUE_OPTIONS = Object.freeze({
  [QUEUE_NAMES.SKILL_GRAPH]: {
    concurrency:   3,    // lightweight graph traversal — can run 3 at once
    jobOptions:    { ...DEFAULT_JOB_OPTIONS },
    priority:      2,    // high priority — downstream workers depend on this
  },
  [QUEUE_NAMES.CAREER_HEALTH]: {
    concurrency:   2,    // CHI is compute-heavy but fast (no LLM)
    jobOptions:    { ...DEFAULT_JOB_OPTIONS },
    priority:      2,
  },
  [QUEUE_NAMES.JOB_MATCHING]: {
    concurrency:   3,
    jobOptions:    { ...DEFAULT_JOB_OPTIONS },
    priority:      3,
  },
  [QUEUE_NAMES.RISK_ANALYSIS]: {
    concurrency:   2,
    jobOptions:    { ...DEFAULT_JOB_OPTIONS, attempts: 3 },
    priority:      3,
  },
  [QUEUE_NAMES.OPPORTUNITY_RADAR]: {
    concurrency:   2,
    jobOptions:    { ...DEFAULT_JOB_OPTIONS },
    priority:      4,    // lower priority — runs after core engines
  },
  [QUEUE_NAMES.CAREER_ADVISOR]: {
    concurrency:   1,    // Claude call — keep concurrency low to respect rate limits
    jobOptions:    {
      ...DEFAULT_JOB_OPTIONS,
      attempts: 2,       // fewer retries — LLM failures are expensive
      backoff: { type: 'fixed', delay: 5000 },
    },
    priority:      5,    // lowest priority — advisory, not blocking
  },
});

// ─── Event → Queue routing map ────────────────────────────────────────────────

/**
 * Maps each event type to the list of queues it should dispatch jobs to.
 * A single event can fan out to multiple queues (parallel execution).
 *
 * Event Types:
 *   USER_PROFILE_CREATED      — new user, run full initial analysis
 *   CV_PARSED                 — resume parsed, kick off all downstream engines
 *   SKILLS_EXTRACTED          — skills known, run skill-dependent engines
 *   CAREER_ANALYSIS_REQUESTED — explicit full-analysis request from dashboard
 *   JOB_MATCH_REQUESTED       — user explicitly requests job matches
 *   RISK_ANALYSIS_REQUESTED   — user explicitly requests risk analysis
 *   OPPORTUNITY_SCAN_REQUESTED — user explicitly requests opportunity radar
 *   CAREER_ADVICE_REQUESTED   — user explicitly requests AI advice
 */
const EVENT_TO_QUEUES = Object.freeze({
  USER_PROFILE_CREATED: [
    QUEUE_NAMES.SKILL_GRAPH,
    QUEUE_NAMES.JOB_MATCHING,
    QUEUE_NAMES.OPPORTUNITY_RADAR,
  ],

  CV_PARSED: [
    QUEUE_NAMES.SKILL_GRAPH,
    QUEUE_NAMES.CAREER_HEALTH,
    QUEUE_NAMES.JOB_MATCHING,
    QUEUE_NAMES.RISK_ANALYSIS,
    QUEUE_NAMES.OPPORTUNITY_RADAR,
  ],

  SKILLS_EXTRACTED: [
    QUEUE_NAMES.CAREER_HEALTH,
    QUEUE_NAMES.JOB_MATCHING,
    QUEUE_NAMES.OPPORTUNITY_RADAR,
  ],

  CAREER_ANALYSIS_REQUESTED: [
    QUEUE_NAMES.SKILL_GRAPH,
    QUEUE_NAMES.CAREER_HEALTH,
    QUEUE_NAMES.JOB_MATCHING,
    QUEUE_NAMES.RISK_ANALYSIS,
    QUEUE_NAMES.OPPORTUNITY_RADAR,
    QUEUE_NAMES.CAREER_ADVISOR,
  ],

  JOB_MATCH_REQUESTED: [
    QUEUE_NAMES.JOB_MATCHING,
  ],

  RISK_ANALYSIS_REQUESTED: [
    QUEUE_NAMES.RISK_ANALYSIS,
  ],

  OPPORTUNITY_SCAN_REQUESTED: [
    QUEUE_NAMES.OPPORTUNITY_RADAR,
  ],

  CAREER_ADVICE_REQUESTED: [
    QUEUE_NAMES.CAREER_ADVISOR,
  ],
});

// ─── Redis connection options for BullMQ ─────────────────────────────────────

/**
 * BullMQ requires a raw ioredis connection config (not the ioredis instance).
 * This is separate from the existing cacheManager — BullMQ manages its own
 * connection pool internally.
 */
function getBullMQRedisConnection() {
  if (process.env.REDIS_URL) {
    return { url: process.env.REDIS_URL };
  }
  return {
    host:     process.env.REDIS_HOST     || '127.0.0.1',
    port:     parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    tls:      process.env.REDIS_TLS === 'true' ? {} : undefined,
    maxRetriesPerRequest: null,  // required by BullMQ
    enableReadyCheck:     false, // required by BullMQ
  };
}

module.exports = {
  QUEUE_NAMES,
  QUEUE_OPTIONS,
  EVENT_TO_QUEUES,
  DEFAULT_JOB_OPTIONS,
  getBullMQRedisConnection,
};









