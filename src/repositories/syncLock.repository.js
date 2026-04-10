'use strict';

/**
 * src/repositories/syncLock.repository.js
 *
 * Wave 1 hardened distributed sync lock repository
 */

const { getSupabaseClient } = require('../lib/supabaseClient');
const logger = require('../utils/logger');

function normalizeAcquireResult(data) {
  if (!data) {
    return {
      acquired: false,
      lock: null,
    };
  }

  const row = Array.isArray(data) ? data[0] : data;

  if (typeof row === 'boolean') {
    return {
      acquired: row,
      lock: null,
    };
  }

  if (typeof row === 'object') {
    return {
      acquired: Boolean(
        row.acquired ??
        row.success ??
        row.locked ??
        true
      ),
      lock: row,
    };
  }

  return {
    acquired: Boolean(data),
    lock: null,
  };
}

function normalizeReleaseResult(data) {
  if (data == null) return false;

  if (typeof data === 'boolean') {
    return data;
  }

  if (typeof data === 'number') {
    return data > 0;
  }

  const row = Array.isArray(data) ? data[0] : data;

  if (typeof row === 'object') {
    return Boolean(
      row.released ??
      row.success ??
      row.deleted ??
      false
    );
  }

  return Boolean(row);
}

async function acquireLock({
  lockKey,
  instanceId,
  staleCutoff,
}) {
  validateAcquireInput(lockKey, instanceId, staleCutoff);

  const supabase = getSupabaseClient();
  const staleIso = staleCutoff.toISOString();

  const { data, error } = await supabase.rpc(
    'acquire_sync_lock',
    {
      p_lock_key: lockKey,
      p_instance_id: instanceId,
      p_stale_cutoff: staleIso,
    }
  );

  if (error) {
    logger.error('[syncLock] acquire RPC failed', {
      rpc: 'acquire_sync_lock',
      lockKey,
      instanceId,
      staleIso,
      staleEpoch: staleCutoff.getTime(),
      code: error.code,
      details: error.details,
      message: error.message,
    });

    throw new Error(
      `syncLock.acquireLock failed: ${error.message}`
    );
  }

  const result = normalizeAcquireResult(data);

  logger.debug('[syncLock] acquire complete', {
    lockKey,
    instanceId,
    acquired: result.acquired,
  });

  return result;
}

async function releaseLock({ lockKey, instanceId }) {
  validateReleaseInput(lockKey, instanceId);

  const supabase = getSupabaseClient();

  const { data, error } = await supabase.rpc(
    'release_sync_lock',
    {
      p_lock_key: lockKey,
      p_instance_id: instanceId,
    }
  );

  if (error) {
    logger.error('[syncLock] release RPC failed', {
      rpc: 'release_sync_lock',
      lockKey,
      instanceId,
      code: error.code,
      details: error.details,
      message: error.message,
    });

    throw new Error(
      `syncLock.releaseLock failed: ${error.message}`
    );
  }

  const released = normalizeReleaseResult(data);

  logger.debug('[syncLock] release complete', {
    lockKey,
    instanceId,
    released,
  });

  return released;
}

async function getLock(lockKey) {
  if (!lockKey) {
    throw new Error('syncLock.getLock: lockKey is required');
  }

  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from('sync_locks')
    .select('*')
    .eq('lock_id', lockKey)
    .maybeSingle();

  if (error) {
    logger.error('[syncLock] getLock failed', {
      lockKey,
      code: error.code,
      details: error.details,
      message: error.message,
    });

    throw new Error(
      `syncLock.getLock failed: ${error.message}`
    );
  }

  return data ?? null;
}

function validateAcquireInput(
  lockKey,
  instanceId,
  staleCutoff
) {
  if (!lockKey) {
    throw new Error(
      'syncLock.acquireLock: lockKey is required'
    );
  }

  if (!instanceId) {
    throw new Error(
      'syncLock.acquireLock: instanceId is required'
    );
  }

  if (
    !(staleCutoff instanceof Date) ||
    Number.isNaN(staleCutoff.getTime())
  ) {
    throw new Error(
      'syncLock.acquireLock: staleCutoff must be valid Date'
    );
  }
}

function validateReleaseInput(lockKey, instanceId) {
  if (!lockKey) {
    throw new Error(
      'syncLock.releaseLock: lockKey is required'
    );
  }

  if (!instanceId) {
    throw new Error(
      'syncLock.releaseLock: instanceId is required'
    );
  }
}

module.exports = {
  acquireLock,
  releaseLock,
  getLock,
};