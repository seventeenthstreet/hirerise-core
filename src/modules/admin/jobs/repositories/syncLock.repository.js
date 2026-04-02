'use strict';

/**
 * syncLock.repository.js — Supabase Distributed Atomic Lock
 * Race-safe for multi-instance production
 */

const logger = require('../../../../utils/logger');

function getSupabase() {
  return require('../../../../config/supabase');
}

const LOCK_ID = 'jobSync';
const LOCK_TIMEOUT_MINUTES = 30;

class SyncLockRepository {
  async acquireLock(lockedBy) {
    if (!lockedBy) {
      throw new Error('Invalid lockedBy value for sync lock');
    }

    const supabase = getSupabase();
    const now = new Date();
    const staleBefore = new Date(
      now.getTime() - LOCK_TIMEOUT_MINUTES * 60 * 1000
    ).toISOString();

    // Atomic conditional lock acquisition
    const { data, error } = await supabase
      .from('sync_locks')
      .update({
        status: 'running',
        locked_by: lockedBy,
        locked_at: now.toISOString(),
        released_at: null,
      })
      .eq('lock_id', LOCK_ID)
      .or(`status.eq.idle,locked_at.lt.${staleBefore}`)
      .select('lock_id')
      .maybeSingle();

    if (error) {
      logger.error('[SyncLock.acquireLock] failed', {
        error: error.message,
      });

      return {
        acquired: false,
        reason: error.message,
      };
    }

    // If no row updated, lock is already active
    if (!data) {
      const status = await this.getStatus();

      return {
        acquired: false,
        reason: `Already locked by ${status.locked_by || 'another worker'}`,
      };
    }

    logger.info('[SyncLock] Lock acquired', {
      lockedBy,
    });

    return { acquired: true };
  }

  async releaseLock(lockedBy) {
    const supabase = getSupabase();

    const { error } = await supabase
      .from('sync_locks')
      .update({
        status: 'idle',
        locked_by: null,
        locked_at: null,
        released_at: new Date().toISOString(),
      })
      .eq('lock_id', LOCK_ID);

    if (error) {
      logger.error('[SyncLock.releaseLock] failed', {
        error: error.message,
      });

      throw error;
    }

    logger.info('[SyncLock] Lock released', { lockedBy });
  }

  async getStatus() {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('sync_locks')
      .select('*')
      .eq('lock_id', LOCK_ID)
      .maybeSingle();

    if (error) {
      throw error;
    }

    return data || {
      lock_id: LOCK_ID,
      status: 'idle',
    };
  }
}

module.exports = new SyncLockRepository();