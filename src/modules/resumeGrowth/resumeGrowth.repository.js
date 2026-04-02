'use strict';

/**
 * resumeGrowth.repository.js
 *
 * Supabase version — stores growth signal snapshots.
 */

const { supabase } = require('../../config/supabase');

const TABLE = 'resume_growth_signals';

class ResumeGrowthRepository {

  /**
   * Persist a growth signal result for a user + role.
   * Always appends (never overwrites).
   */
  async save(userId, roleId, signal) {
    const { data, error } = await supabase
      .from(TABLE)
      .insert({
        user_id: userId,
        role_id: roleId,
        signal,
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) {
      throw new Error(`[ResumeGrowthRepository] save failed: ${error.message}`);
    }

    return data.id;
  }

  /**
   * Fetch most recent signal.
   */
  async getLatest(userId, roleId) {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('user_id', userId)
      .eq('role_id', roleId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new Error(`[ResumeGrowthRepository] getLatest failed: ${error.message}`);
    }

    return data || null;
  }

  /**
   * Fetch full history.
   */
  async getHistory(userId, roleId) {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('user_id', userId)
      .eq('role_id', roleId)
      .order('created_at', { ascending: true });

    if (error) {
      throw new Error(`[ResumeGrowthRepository] getHistory failed: ${error.message}`);
    }

    return data || [];
  }
}

module.exports = ResumeGrowthRepository;





