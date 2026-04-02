'use strict';

/**
 * partitioned-jobs.repository.js — HARDENED
 *
 * ✅ CJS aligned
 * ✅ Atomic fail handling
 * ✅ Attempt increment fixed
 * ✅ Status guards added
 * ✅ Error normalization
 */

const { supabase } = require('../../src/config/supabaseClient');
const logger = require('../logger');

// ─────────────────────────────────────────────
// Helper
// ─────────────────────────────────────────────
async function execute(query, context) {
  const { data, error } = await query;

  if (error) {
    logger.error('DB error', { error, ...context });

    const err = new Error(error.message);
    err.code = 'DB_ERROR';
    throw err;
  }

  return data;
}

// ─────────────────────────────────────────────
// Repository
// ─────────────────────────────────────────────

class PartitionedJobRepository {

  // ── CREATE ──
  async createJob(jobId, jobData) {
    await execute(
      supabase.from('automation_jobs').insert({
        id: jobId,
        ...jobData,
        status: 'pending',
        attempts: 0,
        max_attempts: 5,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        deleted_at: null,
      }),
      { method: 'createJob', jobId }
    );

    return jobId;
  }

  // ── CLAIM (RPC) ──
  async claimJob(jobId, workerId) {
    const { data, error } = await supabase.rpc('claim_job', {
      p_job_id: jobId,
      p_worker_id: workerId,
    });

    if (error) {
      logger.error('claimJob failed', { error, jobId, workerId });
      throw error;
    }

    return data;
  }

  // ── COMPLETE ──
  async completeJob(jobId, result = {}) {
    await execute(
      supabase
        .from('automation_jobs')
        .update({
          status: 'complete',
          result,
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', jobId)
        .eq('status', 'processing'), // ✅ guard
      { method: 'completeJob', jobId }
    );
  }

  // ── FAIL (FIXED ATOMICITY) ──
  async failJob(jobId, errorCode, errorMessage) {
    const { data, error } = await supabase.rpc('fail_job', {
      p_job_id: jobId,
      p_error_code: errorCode,
      p_error_message: errorMessage?.slice(0, 500),
    });

    if (error) {
      logger.error('failJob failed', { error, jobId });
      throw error;
    }

    return data; // { status: 'failed' | 'dead' }
  }

  // ── READ ──

  async findById(jobId) {
    return await execute(
      supabase
        .from('automation_jobs')
        .select('*')
        .eq('id', jobId)
        .is('deleted_at', null)
        .maybeSingle(),
      { method: 'findById', jobId }
    );
  }

  async getPendingJobsForUser(userId, limit = 10) {
    return (
      await execute(
        supabase
          .from('automation_jobs')
          .select('id, status, created_at')
          .eq('user_id', userId)
          .in('status', ['pending', 'processing'])
          .is('deleted_at', null)
          .order('created_at', { ascending: false })
          .limit(limit),
        { method: 'getPendingJobsForUser', userId }
      )
    ) ?? [];
  }

  async countPendingForUser(userId) {
    const { count, error } = await supabase
      .from('automation_jobs')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .in('status', ['pending', 'processing'])
      .is('deleted_at', null);

    if (error) throw error;
    return count ?? 0;
  }

  async getDeadJobs({ limit = 50, since = null } = {}) {
    let query = supabase
      .from('automation_jobs')
      .select('id, failed_at, last_error_code')
      .eq('status', 'dead')
      .order('failed_at', { ascending: false })
      .limit(limit);

    if (since) {
      query = query.gte('failed_at', since.toISOString());
    }

    return (await execute(query, { method: 'getDeadJobs' })) ?? [];
  }
}

module.exports = {
  PartitionedJobRepository,
  partitionedJobRepo: new PartitionedJobRepository(),
};