'use strict';

const supabase = require('../config/supabase');
const crypto = require('crypto');
const logger = require('../utils/logger');

const TABLE = 'automation_jobs';

class PartitionedJobRepository {

  // ─────────────────────────────────────────────
  // CREATE JOB
  // ─────────────────────────────────────────────

  async createJob(jobId, jobData) {
    // Idempotency check
    if (jobData.idempotencyKey) {
      const { data } = await supabase
        .from(TABLE)
        .select('*')
        .eq('id', jobId)
        .maybeSingle();

      if (data && data.idempotency_key === jobData.idempotencyKey) {
        logger.info('[JobRepo] Duplicate job');
        return { jobId, duplicate: true, status: data.status };
      }
    }

    const record = {
      id: jobId,
      ...jobData,
      status: 'pending',
      attempts: 0,
      max_attempts: 5,
      idempotency_key: jobData.idempotencyKey || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleted_at: null,
    };

    const { error } = await supabase.from(TABLE).insert(record);
    if (error) throw error;

    return { jobId, duplicate: false };
  }

  // ─────────────────────────────────────────────
  // CLAIM JOB (simulate transaction)
  // ─────────────────────────────────────────────

  async claimJob(jobId, workerId) {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('id', jobId)
      .maybeSingle();

    if (error || !data) throw new Error('Job not found');

    if (['processing', 'complete'].includes(data.status)) {
      return { claimed: false, status: data.status };
    }

    const { error: updateError } = await supabase
      .from(TABLE)
      .update({
        status: 'processing',
        worker_id: workerId,
        claimed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        attempts: data.attempts + 1,
      })
      .eq('id', jobId);

    if (updateError) throw updateError;

    return { claimed: true, data };
  }

  // ─────────────────────────────────────────────
  // COMPLETE JOB
  // ─────────────────────────────────────────────

  async completeJob(jobId, result = {}) {
    const { error } = await supabase
      .from(TABLE)
      .update({
        status: 'complete',
        result,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId);

    if (error) throw error;
  }

  // ─────────────────────────────────────────────
  // FAIL JOB
  // ─────────────────────────────────────────────

  async failJob(jobId, errorCode, errorMessage) {
    const { data } = await supabase
      .from(TABLE)
      .select('*')
      .eq('id', jobId)
      .maybeSingle();

    if (!data) throw new Error('Job not found');

    const newStatus =
      data.attempts >= data.max_attempts ? 'dead' : 'failed';

    const { error } = await supabase
      .from(TABLE)
      .update({
        status: newStatus,
        last_error_code: errorCode,
        last_error_message: errorMessage?.slice(0, 500),
        failed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId);

    if (error) throw error;

    return newStatus;
  }

  // ─────────────────────────────────────────────
  // FIND
  // ─────────────────────────────────────────────

  async findById(jobId) {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('id', jobId)
      .maybeSingle();

    if (error || !data || data.deleted_at) return null;
    return data;
  }

  // ─────────────────────────────────────────────
  // USER JOBS
  // ─────────────────────────────────────────────

  async getPendingJobsForUser(userId, limit = 10) {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('user_id', userId)
      .in('status', ['pending', 'processing'])
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data || [];
  }

  async countPendingForUser(userId) {
    const { count, error } = await supabase
      .from(TABLE)
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .in('status', ['pending', 'processing'])
      .is('deleted_at', null);

    if (error) throw error;
    return count || 0;
  }

  async getDeadJobs({ limit = 50 } = {}) {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('status', 'dead')
      .order('failed_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data || [];
  }
}

module.exports = new PartitionedJobRepository();





