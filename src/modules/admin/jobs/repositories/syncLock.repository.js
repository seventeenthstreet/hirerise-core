'use strict';

/**
 * syncLock.repository.js — Job Sync Distributed Lock (Supabase)
 * MIGRATED: Firestore syncLocks → Supabase sync_locks table
 */

const logger = require('../../../../utils/logger');

function getSupabase() { return require('../../../../core/supabaseClient'); }
const LOCK_ID = 'jobSync';
const LOCK_TIMEOUT_MINUTES = 30;

class SyncLockRepository {

  async acquireLock(lockedBy) {
    if (!lockedBy) throw new Error('Invalid lockedBy value for sync lock');
    const supabase = getSupabase();

    // Read current lock
    const { data: current } = await supabase
      .from('sync_locks').select('*').eq('lock_id', LOCK_ID).single();

    const now = new Date();

    if (current?.status === 'running') {
      const lockedAt = current.locked_at ? new Date(current.locked_at) : null;
      if (lockedAt) {
        const diffMinutes = (now.getTime() - lockedAt.getTime()) / (1000 * 60);
        if (diffMinutes <= LOCK_TIMEOUT_MINUTES) {
          return { acquired: false, reason: `Already locked by ${current.locked_by}` };
        }
        logger.warn('[SyncLock] Stale lock detected — taking over', { previousLockedBy: current.locked_by });
      }
    }

    const { error } = await supabase.from('sync_locks').upsert({
      lock_id:   LOCK_ID,
      status:    'running',
      locked_by: lockedBy,
      locked_at: now.toISOString(),
    }, { onConflict: 'lock_id' });

    if (error) return { acquired: false, reason: error.message };
    logger.info('[SyncLock] Lock acquired', { lockedBy });
    return { acquired: true };
  }

  async releaseLock(lockedBy) {
    const supabase = getSupabase();
    await supabase.from('sync_locks').update({
      status:       'idle',
      locked_by:    null,
      locked_at:    null,
      released_at:  new Date().toISOString(),
    }).eq('lock_id', LOCK_ID);
    logger.info('[SyncLock] Lock released', { lockedBy });
  }

  async getStatus() {
    const supabase = getSupabase();
    const { data } = await supabase.from('sync_locks').select('*').eq('lock_id', LOCK_ID).single();
    return data || { lock_id: LOCK_ID, status: 'idle' };
  }
}

module.exports = new SyncLockRepository();








