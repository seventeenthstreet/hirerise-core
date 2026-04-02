'use strict';

/**
 * modules/career-digital-twin/services/digitalTwin.service.js
 *
 * Career Digital Twin orchestration layer.
 */

const logger = require('../../../utils/logger');
const anthropic = require('../../../config/anthropic.client');
const { supabase } = require('../../../config/supabase');
const cacheManager = require('../../../core/cache/cache.manager');
const engine = require('../../../engines/career-digital-twin.engine');

const {
  TABLE,
  buildSimulationRow,
} = require('../models/simulation.model');

const {
  buildNarrativeMessages,
} = require('../prompts/twinPrompt.builder');

const CACHE_TTL_SEC = Number.parseInt(
  process.env.DIGITAL_TWIN_CACHE_TTL_SEC || '1800',
  10
);

const AI_MAX_TOKENS = 1500;
const NARRATIVE_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_HISTORY_LIMIT = 10;

/**
 * Safe cache key generator.
 */
function buildCacheKey(userId, role) {
  const safeUserId = String(userId || 'anonymous');
  const slug = String(role || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .slice(0, 60);

  return `digital_twin:${safeUserId}:${slug}`;
}

/**
 * Best-effort cache read.
 */
async function cacheGet(key) {
  try {
    const cache = cacheManager.getClient();
    const raw = await cache.get(key);

    if (!raw) {
      return null;
    }

    const parsed =
      typeof raw === 'string' ? JSON.parse(raw) : raw;

    logger.debug('[DigitalTwinService] cache:get:hit', { key });

    return parsed;
  } catch (error) {
    logger.warn('[DigitalTwinService] cache:get:failed', {
      key,
      error: error.message,
    });
    return null;
  }
}

/**
 * Best-effort cache write.
 */
async function cacheSet(key, value) {
  try {
    const cache = cacheManager.getClient();
    await cache.set(key, JSON.stringify(value), CACHE_TTL_SEC);

    logger.debug('[DigitalTwinService] cache:set:success', {
      key,
      ttl: CACHE_TTL_SEC,
    });
  } catch (error) {
    logger.warn('[DigitalTwinService] cache:set:failed', {
      key,
      error: error.message,
    });
  }
}

/**
 * Safe JSON extraction from AI response.
 */
function extractJsonPayload(rawText) {
  const text = String(rawText || '').trim();

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');

  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error('No JSON object found in AI response');
  }

  return JSON.parse(text.slice(firstBrace, lastBrace + 1));
}

/**
 * Optional AI narrative enrichment.
 */
async function enrichWithNarratives(userProfile, careerPaths) {
  if (!anthropic || !Array.isArray(careerPaths) || careerPaths.length === 0) {
    return careerPaths;
  }

  try {
    const { system, messages } = buildNarrativeMessages(
      userProfile,
      careerPaths
    );

    const response = await anthropic.messages.create({
      model: NARRATIVE_MODEL,
      max_tokens: AI_MAX_TOKENS,
      temperature: 0.4,
      system,
      messages,
    });

    const rawText = Array.isArray(response?.content)
      ? response.content
          .map((block) => block?.text || '')
          .join('\n')
      : '';

    const parsed = extractJsonPayload(rawText);

    const narrativeMap = new Map(
      Array.isArray(parsed?.narratives)
        ? parsed.narratives.map((item) => [
            item.strategy_id,
            item,
          ])
        : []
    );

    return careerPaths.map((path) => {
      const narrative = narrativeMap.get(path.strategy_id);

      if (!narrative) {
        return path;
      }

      return {
        ...path,
        narrative: narrative.summary ?? null,
        key_milestone: narrative.key_milestone ?? null,
      };
    });
  } catch (error) {
    logger.warn('[DigitalTwinService] narrative:failed', {
      error: error.message,
    });

    return careerPaths;
  }
}

/**
 * Persist simulation row.
 */
async function persistSimulation(userId, simulationResult) {
  try {
    const row = buildSimulationRow(userId, simulationResult);

    const { data, error } = await supabase
      .from(TABLE)
      .insert([row])
      .select('id')
      .single();

    if (error) {
      throw error;
    }

    logger.info('[DigitalTwinService] persist:success', {
      userId,
      simulationId: data?.id,
    });

    return data?.id ?? null;
  } catch (error) {
    logger.warn('[DigitalTwinService] persist:failed', {
      userId,
      error: error.message,
    });

    return null;
  }
}

async function runSimulation({
  userId,
  userProfile,
  marketData = {},
  includeNarrative = false,
  forceRefresh = false,
}) {
  const cacheKey = buildCacheKey(userId, userProfile?.role);

  if (!forceRefresh) {
    const cached = await cacheGet(cacheKey);

    if (cached) {
      return {
        ...cached,
        cached: true,
      };
    }
  }

  logger.info('[DigitalTwinService] simulation:start', {
    userId,
    role: userProfile?.role,
  });

  const simulationResult =
    await engine.simulateCareerPaths(userProfile, marketData);

  if (includeNarrative) {
    simulationResult.career_paths = await enrichWithNarratives(
      userProfile,
      simulationResult.career_paths
    );
  }

  const simulationId = await persistSimulation(
    userId,
    simulationResult
  );

  const response = {
    ...simulationResult,
    simulation_id: simulationId,
    cached: false,
  };

  await cacheSet(cacheKey, response);

  return response;
}

async function getStoredSimulations(
  userId,
  limit = DEFAULT_HISTORY_LIMIT
) {
  const safeLimit = Number.isFinite(limit) ? limit : DEFAULT_HISTORY_LIMIT;

  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(safeLimit);

  if (error) {
    logger.error('[DigitalTwinService] history:failed', {
      userId,
      error: error.message,
    });
    throw error;
  }

  return Array.isArray(data) ? data : [];
}

async function invalidateUserCache(userId, role) {
  if (!role) {
    return;
  }

  const key = buildCacheKey(userId, role);

  try {
    const cache = cacheManager.getClient();

    if (typeof cache.del === 'function') {
      await cache.del(key);
    } else if (typeof cache.delete === 'function') {
      await cache.delete(key);
    }

    logger.info('[DigitalTwinService] cache:invalidate:success', {
      userId,
      key,
    });
  } catch (error) {
    logger.warn('[DigitalTwinService] cache:invalidate:failed', {
      error: error.message,
    });
  }
}

module.exports = {
  runSimulation,
  getStoredSimulations,
  invalidateUserCache,
};