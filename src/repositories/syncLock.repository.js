'use strict';

const { getSupabaseClient } = require('../lib/supabaseClient');
const logger = require('../utils/logger');

async function acquireLock({
  lockKey,
  instanceId,
  staleCutoff,
}) {
  validateAcquireInput(lockKey, instanceId, staleCutoff);

  const supabase = getSupabaseClient();

  const { data, error } = await supabase.rpc(
    'acquire_sync_lock',
    {
      p_lock_key: lockKey,
      p_instance_id: instanceId,
      p_stale_cutoff: staleCutoff.toISOString(),
    }
  );

  if (error) {
    logger.error('[syncLock] acquire failed', {
      lockKey,
      instanceId,
      code: error.code,
      message: error.message,
    });

    throw new Error(
      `syncLock.acquireLock failed: ${error.message}`
    );
  }

  return data ?? null;
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
    logger.error('[syncLock] release failed', {
      lockKey,
      instanceId,
      code: error.code,
      message: error.message,
    });

    throw new Error(
      `syncLock.releaseLock failed: ${error.message}`
    );
  }

  return Boolean(data);
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