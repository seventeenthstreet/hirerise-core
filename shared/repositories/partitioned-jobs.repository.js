'use strict';

const { supabase } = require('../../src/config/supabaseClient');
const logger = require('../logger');

async function execute(query, context) {
  const { data, error } = await query;

  if (error) {
    logger.error('DB error', {
      method: context?.method,
      error: error.message,
    });

    const err = new Error(error.message);
    err.code = 'DB_ERROR';
    throw err;
  }

  return data;
}

function normalizeId(value, field) {
  const normalized = String(value || '').trim();

  if (!normalized) {
    throw new Error(`${field} is required`);
  }

  return normalized;
}

class PartitionedJobRepository {
  async createJob(jobId, jobData) {
    const safeJobId = normalizeId(jobId, 'jobId');

    await execute(
      supabase.from('automation_jobs').insert({
        id: safeJobId,
        ...jobData,
        status: 'pending',
        attempts: 0,
        max_attempts: 5,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        deleted_at: null,
      }),
      { method: 'createJob' }
    );

    return safeJobId;
  }

  async claimJob(jobId, workerId) {
    const safeJobId = normalizeId(jobId, 'jobId');
    const safeWorkerId = normalizeId(workerId, 'workerId');

    const { data, error } = await supabase.rpc('claim_job', {
      p_job_id: safeJobId,
      p_worker_id: safeWorkerId,
    });

    if (error) {
      logger.error('claimJob failed', {
        jobId: safeJobId,
        error: error.message,
      });
      throw error;
    }

    return data;
  }

  async completeJob(jobId, result = {}) {
    const safeJobId = normalizeId(jobId, 'jobId');

    const data = await execute(
      supabase
        .from('automation_jobs')
        .update({
          status: 'complete',
          result,
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', safeJobId)
        .eq('status', 'processing')
        .select('id')
        .maybeSingle(),
      { method: 'completeJob' }
    );

    if (!data?.id) {
      const err = new Error('Job completion no-op: job not in processing state');
      err.code = 'JOB_COMPLETE_NOOP';
      throw err;
    }
  }

  async failJob(jobId, errorCode, errorMessage) {
    const safeJobId = normalizeId(jobId, 'jobId');

    const { data, error } = await supabase.rpc('fail_job', {
      p_job_id: safeJobId,
      p_error_code: String(errorCode || 'UNKNOWN'),
      p_error_message: String(errorMessage || '')
        .slice(0, 500),
    });

    if (error) {
      logger.error('failJob failed', {
        jobId: safeJobId,
        error: error.message,
      });
      throw error;
    }

    return data;
  }

  async findById(jobId) {
    const safeJobId = normalizeId(jobId, 'jobId');

    return await execute(
      supabase
        .from('automation_jobs')
        .select('*')
        .eq('id', safeJobId)
        .is('deleted_at', null)
        .maybeSingle(),
      { method: 'findById' }
    );
  }

  async getPendingJobsForUser(userId, limit = 10) {
    const safeUserId = normalizeId(userId, 'userId');

    return (
      await execute(
        supabase
          .from('automation_jobs')
          .select('id, status, created_at')
          .eq('user_id', safeUserId)
          .in('status', ['pending', 'processing'])
          .is('deleted_at', null)
          .order('created_at', { ascending: false })
          .limit(limit),
        { method: 'getPendingJobsForUser' }
      )
    ) ?? [];
  }

  async countPendingForUser(userId) {
    const safeUserId = normalizeId(userId, 'userId');

    const { count, error } = await supabase
      .from('automation_jobs')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', safeUserId)
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