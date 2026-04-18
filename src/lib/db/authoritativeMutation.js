'use strict';

const { getClient } = require('../../config/supabase');
const logger = require('../../utils/logger');

const mutationFence = new Map();
const MAX_FENCE_KEYS = 10000;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 100;

function getFenceKey(table, payload, conflictKey, requestKey) {
  return `${table}:${requestKey || payload[conflictKey]}`;
}

function getCurrentSeq(key) {
  return mutationFence.get(key) || 0;
}

function commitNextSeq(key, currentSeq) {
  const next = currentSeq + 1;
  mutationFence.set(key, next);

  // simple bounded FIFO eviction to avoid process-lifetime leak
  if (mutationFence.size > MAX_FENCE_KEYS) {
    const oldestKey = mutationFence.keys().next().value;
    if (oldestKey) {
      mutationFence.delete(oldestKey);
    }
  }

  return next;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function authoritativeUpsert({
  table,
  payload,
  conflictKey = 'id',
  requestKey,
}) {
  if (!table) {
    throw new Error('authoritativeUpsert requires table');
  }

  if (!payload || typeof payload !== 'object') {
    throw new Error('authoritativeUpsert requires valid payload');
  }

  const client = getClient();
  const fenceKey = getFenceKey(
    table,
    payload,
    conflictKey,
    requestKey
  );

  const currentSeq = getCurrentSeq(fenceKey);

  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const finalPayload = {
        ...payload,
        updated_at: new Date().toISOString(),
      };

      const { data, error } = await client
        .from(table)
        .upsert(finalPayload, {
          onConflict: conflictKey,
        })
        .select()
        .single();

      if (error) {
        throw error;
      }

      // commit fence only after confirmed success
      commitNextSeq(fenceKey, currentSeq);

      return data;
    } catch (error) {
      lastError = error;

      logger.warn(
        '[Patch45] authoritative upsert attempt failed',
        {
          table,
          conflictKey,
          attempt,
          error: error.message,
        }
      );

      if (attempt < MAX_RETRIES) {
        await sleep(BASE_BACKOFF_MS * Math.pow(2, attempt - 1));
      }
    }
  }

  logger.error('[Patch45] authoritative upsert failed permanently', {
    table,
    conflictKey,
    error: lastError?.message,
  });

  throw lastError;
}

module.exports = {
  authoritativeUpsert,
};