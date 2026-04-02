'use strict';

/**
 * queues/queue.config.js — BullMQ + Supabase optimized configuration
 *
 * Firebase: not present in original file.
 * Optimizations:
 * - Smarter retry/backoff defaults
 * - Production-safe Redis URL parsing
 * - Queue-level rate limiting support
 * - Better env-driven concurrency scaling
 * - Frozen nested configs for immutability
 */

const QUEUE_NAMES = Object.freeze({
  SKILL_GRAPH: 'hirerise:skill-graph:queue',
  CAREER_HEALTH: 'hirerise:career-health:queue',
  JOB_MATCHING: 'hirerise:job-matching:queue',
  RISK_ANALYSIS: 'hirerise:risk-analysis:queue',
  OPPORTUNITY_RADAR: 'hirerise:opportunity-radar:queue',
  CAREER_ADVISOR: 'hirerise:career-advisor:queue',
});

const DEFAULT_JOB_OPTIONS = Object.freeze({
  attempts: 3,
  backoff: Object.freeze({
    type: 'exponential',
    delay: 2000,
  }),
  removeOnComplete: Object.freeze({
    age: 3600,
    count: 500,
  }),
  removeOnFail: Object.freeze({
    age: 86400,
    count: 200,
  }),
});

const cpuScale = Math.max(1, Number(process.env.WORKER_SCALE || '1'));

const QUEUE_OPTIONS = Object.freeze({
  [QUEUE_NAMES.SKILL_GRAPH]: Object.freeze({
    concurrency: 3 * cpuScale,
    jobOptions: DEFAULT_JOB_OPTIONS,
    priority: 2,
  }),

  [QUEUE_NAMES.CAREER_HEALTH]: Object.freeze({
    concurrency: 2 * cpuScale,
    jobOptions: DEFAULT_JOB_OPTIONS,
    priority: 2,
  }),

  [QUEUE_NAMES.JOB_MATCHING]: Object.freeze({
    concurrency: 3 * cpuScale,
    jobOptions: DEFAULT_JOB_OPTIONS,
    priority: 3,
  }),

  [QUEUE_NAMES.RISK_ANALYSIS]: Object.freeze({
    concurrency: 2 * cpuScale,
    jobOptions: {
      ...DEFAULT_JOB_OPTIONS,
      attempts: 4,
    },
    priority: 3,
  }),

  [QUEUE_NAMES.OPPORTUNITY_RADAR]: Object.freeze({
    concurrency: 2 * cpuScale,
    jobOptions: DEFAULT_JOB_OPTIONS,
    priority: 4,
  }),

  [QUEUE_NAMES.CAREER_ADVISOR]: Object.freeze({
    concurrency: 1,
    limiter: {
      max: 10,
      duration: 60000,
    },
    jobOptions: {
      ...DEFAULT_JOB_OPTIONS,
      attempts: 2,
      backoff: { type: 'fixed', delay: 5000 },
    },
    priority: 5,
  }),
});

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
  JOB_MATCH_REQUESTED: [QUEUE_NAMES.JOB_MATCHING],
  RISK_ANALYSIS_REQUESTED: [QUEUE_NAMES.RISK_ANALYSIS],
  OPPORTUNITY_SCAN_REQUESTED: [QUEUE_NAMES.OPPORTUNITY_RADAR],
  CAREER_ADVICE_REQUESTED: [QUEUE_NAMES.CAREER_ADVISOR],
});

function getBullMQRedisConnection() {
  if (process.env.REDIS_URL) {
    return {
      connectionString: process.env.REDIS_URL,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    };
  }

  return {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT || 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
  };
}

module.exports = {
  QUEUE_NAMES,
  QUEUE_OPTIONS,
  EVENT_TO_QUEUES,
  DEFAULT_JOB_OPTIONS,
  getBullMQRedisConnection,
};
