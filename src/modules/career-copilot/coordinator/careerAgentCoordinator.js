'use strict';

/**
 * src/modules/career-copilot/coordinator/careerAgentCoordinator.js
 *
 * Career Copilot coordinator for:
 * - CareerRiskAgent
 * - OpportunityRadarAgent
 *
 * Production-grade features:
 * - parallel execution
 * - BaseAgent Redis caching via execute()
 * - coordinator-level stale prewarm detection
 * - Redis debounce
 * - graceful degradation
 * - legacy EventBus dependency fully removed
 * - queue/RPC ready prewarm hook
 */

const {
  CareerRiskAgent,
  OpportunityRadarAgent,
} = require('../agents/riskAndRadarAgents.js');

const logger = require('../../../utils/logger');

const redis = safeRequire(
  '../../../config/redis',
  'Redis'
);

const HARD_STALE_HOURS = Number(
  process.env.PRECOMPUTED_AGENT_MAX_AGE_HOURS || 24
);

const PREWARM_THRESHOLD_HOURS = (() => {
  const configured = Number(
    process.env.PREWARM_THRESHOLD_HOURS || 20
  );

  if (configured >= HARD_STALE_HOURS) {
    const fallback = Math.max(1, HARD_STALE_HOURS - 4);

    logger.warn(
      '[CareerAgentCoordinator] Invalid PREWARM_THRESHOLD_HOURS, using fallback',
      {
        configured,
        fallback,
        hard_stale: HARD_STALE_HOURS,
      }
    );

    return fallback;
  }

  return configured;
})();

const PREWARM_DEBOUNCE_TTL_SECONDS = 1800;

const riskAgent = new CareerRiskAgent();
const radarAgent = new OpportunityRadarAgent();

/**
 * Main coordinator execution
 *
 * @param {string} userId
 * @param {object} context
 * @returns {Promise<object>}
 */
async function run(userId, context = {}) {
  if (!userId) {
    throw new TypeError(
      '[CareerAgentCoordinator] userId is required'
    );
  }

  const [riskEnvelope, radarEnvelope] = await Promise.all([
    riskAgent.execute(userId, context),
    radarAgent.execute(userId, context).catch((err) => {
      logger.warn(
        '[CareerAgentCoordinator] RadarAgent failed — degrading',
        {
          userId,
          error: err instanceof Error
            ? err.message
            : String(err),
        }
      );

      return { output: null };
    }),
  ]);

  const riskResult = riskEnvelope?.output || null;
  const radarResult = radarEnvelope?.output || null;

  // fire-and-forget background prewarm intent
  void _maybePrewarm('risk', userId, riskResult);
  void _maybePrewarm('radar', userId, radarResult);

  return _buildResponse(userId, riskResult, radarResult);
}

/**
 * Trigger async refresh intent if result is soft-stale.
 * Current production-safe behavior:
 * - debounce duplicate refresh intents via Redis
 * - emit structured log hook for queue/cron SQL workers
 */
async function _maybePrewarm(agent, userId, result) {
  if (!result || result.source !== 'precomputed') {
    return;
  }

  const computedAt = result._computed_at;
  if (!computedAt) {
    return;
  }

  const ageHours = _ageHours(computedAt);

  if (ageHours < PREWARM_THRESHOLD_HOURS) {
    return;
  }

  if (ageHours >= HARD_STALE_HOURS) {
    logger.warn('[CareerAgentCoordinator] stale_hard_fallback', {
      log_event: 'stale_hard_fallback',
      agent,
      userId,
      age_hours: ageHours.toFixed(2),
      hard_stale: HARD_STALE_HOURS,
    });
    return;
  }

  const debounceKey = `prewarm:${agent}:${userId}`;

  if (redis?.set) {
    try {
      const acquired = await redis.set(
        debounceKey,
        '1',
        'EX',
        PREWARM_DEBOUNCE_TTL_SECONDS,
        'NX'
      );

      if (!acquired) {
        logger.info(
          '[CareerAgentCoordinator] skipped_recent_prewarm',
          {
            log_event: 'skipped_recent_prewarm',
            agent,
            userId,
            debounce_key: debounceKey,
          }
        );
        return;
      }
    } catch (err) {
      logger.warn(
        '[CareerAgentCoordinator] Redis debounce failed',
        {
          agent,
          userId,
          error: err instanceof Error
            ? err.message
            : String(err),
        }
      );
    }
  }

  await _triggerPrewarm(agent, userId, ageHours);
}

/**
 * Queue-first prewarm hook.
 *
 * For now this emits a structured observability event that your
 * worker / SQL cron / BullMQ layer can consume safely.
 */
async function _triggerPrewarm(agent, userId, ageHours) {
  try {
    logger.info('[CareerAgentCoordinator] prewarm_requested', {
      log_event: 'prewarm_requested',
      agent,
      userId,
      age_hours: Number(ageHours.toFixed(2)),
      threshold: PREWARM_THRESHOLD_HOURS,
      triggered_by: 'coordinator_prewarm',
    });
  } catch (err) {
    logger.warn(
      '[CareerAgentCoordinator] Prewarm hook failed',
      {
        agent,
        userId,
        error: err instanceof Error
          ? err.message
          : String(err),
      }
    );
  }
}

function _buildResponse(userId, riskResult, radarResult) {
  return {
    userId,
    risk: riskResult ? _stripInternal(riskResult) : null,
    radar: radarResult ? _stripInternal(radarResult) : null,
    meta: {
      prewarm_threshold_hours: PREWARM_THRESHOLD_HOURS,
      hard_stale_hours: HARD_STALE_HOURS,
      generated_at: new Date().toISOString(),
    },
  };
}

function _stripInternal(result) {
  if (!result || typeof result !== 'object') {
    return result;
  }

  return Object.fromEntries(
    Object.entries(result).filter(
      ([key]) => !key.startsWith('_')
    )
  );
}

function _ageHours(computedAt) {
  const ageMs = Date.now() - new Date(computedAt).getTime();
  return Math.max(0, ageMs / (1000 * 60 * 60));
}

function safeRequire(path, name) {
  try {
    return require(path);
  } catch (err) {
    logger.warn(
      `[CareerAgentCoordinator] ${name} unavailable`,
      {
        error: err instanceof Error
          ? err.message
          : 'Unknown require error',
      }
    );
    return null;
  }
}

module.exports = { run };