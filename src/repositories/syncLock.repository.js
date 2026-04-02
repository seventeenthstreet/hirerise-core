'use strict';

/**
 * syncLock.repository.js
 * ----------------------
 * Production-grade data access layer for sync_locks.
 *
 * Features:
 * - atomic conditional UPDATE lock acquisition
 * - stale lock takeover
 * - ownership-safe release
 * - conflict diagnostics
 *
 * path: src/repositories/syncLock.repository.js
 */

const { getSupabaseClient } = require('../lib/supabaseClient');

const TABLE = 'sync_locks';

/**
 * Atomically acquire a distributed lock.
 *
 * Succeeds only when:
 * - status = 'idle'
 * - OR stale running lock older than staleCutoff
 */
async function acquireLock({ lockKey, instanceId, staleCutoff }) {
  if (!lockKey) {
    throw new Error('syncLock.acquireLock: lockKey is required');
  }

  if (!instanceId) {
    throw new Error('syncLock.acquireLock: instanceId is required');
  }

  if (!(staleCutoff instanceof Date) || Number.isNaN(staleCutoff.getTime())) {
    throw new Error('syncLock.acquireLock: staleCutoff must be a valid Date');
  }

  const supabase = getSupabaseClient();
  const nowIso = new Date().toISOString();
  const staleIso = staleCutoff.toISOString();

  const { data, error } = await supabase
    .from(TABLE)
    .update({
      status: 'running',
      locked_by: instanceId,
      locked_at: nowIso,
      released_at: null,
      updated_at: nowIso,
    })
    .eq('lock_id', lockKey)
    .or(`status.eq.idle,and(status.eq.running,locked_at.lt.${staleIso})`)
    .select('*')
    .maybeSingle();

  if (error) {
    throw new Error(`syncLock.acquireLock failed: ${error.message}`);
  }

  return data || null;
}

/**
 * Release the lock only if this instance owns it.
 */
async function releaseLock({ lockKey, instanceId }) {
  if (!lockKey) {
    throw new Error('syncLock.releaseLock: lockKey is required');
  }

  if (!instanceId) {
    throw new Error('syncLock.releaseLock: instanceId is required');
  }

  const supabase = getSupabaseClient();
  const nowIso = new Date().toISOString();

  const { data, error } = await supabase
    .from(TABLE)
    .update({
      status: 'idle',
      locked_by: null,
      locked_at: null,
      released_at: nowIso,
      updated_at: nowIso,
    })
    .eq('lock_id', lockKey)
    .eq('locked_by', instanceId)
    .eq('status', 'running')
    .select('*')
    .maybeSingle();

  if (error) {
    throw new Error(`syncLock.releaseLock failed: ${error.message}`);
  }

  return data !== null;
}

/**
 * Fetch current lock state for diagnostics.
 */
async function getLock(lockKey) {
  if (!lockKey) {
    throw new Error('syncLock.getLock: lockKey is required');
  }

  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('lock_id', lockKey)
    .maybeSingle();

  if (error) {
    throw new Error(`syncLock.getLock failed: ${error.message}`);
  }

  return data || null;
}

module.exports = {
  acquireLock,
  releaseLock,
  getLock,
};