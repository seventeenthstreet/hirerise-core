'use strict';

const { supabase } = require('../config/supabase');
const logger = require('../utils/logger');

const TABLE = 'automation_jobs';

class PartitionedJobRepository {
  constructor(db = supabase) {
    this.db = db;
  }

  async createJob(jobId, jobData = {}) {
    const now = this.#now();

    const record = {
      id: jobId,
      ...jobData,
      status: 'pending',
      attempts: 0,
      max_attempts: Number(jobData.maxAttempts ?? 5),
      idempotency_key: jobData.idempotencyKey ?? null,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };

    const { error } = await this.db
      .from(TABLE)
      .upsert(record, { onConflict: 'id' });

    if (error) {
      logger.error('[PartitionedJobRepository] createJob failed', {
        jobId,
        code: error.code,
        message: error.message,
      });
      throw error;
    }

    return { jobId, duplicate: false };
  }

  async claimJob(jobId, workerId) {
    const { data, error } = await this.db.rpc(
      'claim_automation_job',
      {
        p_job_id: jobId,
        p_worker_id: workerId,
      }
    );

    if (error) {
      logger.error('[PartitionedJobRepository] claimJob failed', {
        jobId,
        workerId,
        code: error.code,
        message: error.message,
      });
      throw error;
    }

    return data;
  }

  async completeJob(jobId, result = {}) {
    const { error } = await this.db
      .from(TABLE)
      .update({
        status: 'complete',
        result,
        completed_at: this.#now(),
        updated_at: this.#now(),
      })
      .eq('id', jobId)
      .is('deleted_at', null);

    if (error) throw error;
  }

  async failJob(jobId, errorCode, errorMessage) {
    const { data, error } = await this.db.rpc(
      'fail_automation_job',
      {
        p_job_id: jobId,
        p_error_code: errorCode,
        p_error_message: errorMessage ?? '',
      }
    );

    if (error) throw error;
    return data;
  }

  async findById(jobId) {
    const { data, error } = await this.db
      .from(TABLE)
      .select('*')
      .eq('id', jobId)
      .is('deleted_at', null)
      .maybeSingle();

    if (error || !data) return null;
    return data;
  }

  async getPendingJobsForUser(userId, limit = 10) {
    const { data, error } = await this.db
      .from(TABLE)
      .select('*')
      .eq('user_id', userId)
      .in('status', ['pending', 'processing'])
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(Math.min(Number(limit) || 10, 100));

    if (error) throw error;
    return data ?? [];
  }

  async countPendingForUser(userId) {
    const { count, error } = await this.db
      .from(TABLE)
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .in('status', ['pending', 'processing'])
      .is('deleted_at', null);

    if (error) throw error;
    return count ?? 0;
  }

  async getDeadJobs({ limit = 50 } = {}) {
    const { data, error } = await this.db
      .from(TABLE)
      .select('*')
      .eq('status', 'dead')
      .is('deleted_at', null)
      .order('failed_at', { ascending: false })
      .limit(Math.min(Number(limit) || 50, 200));

    if (error) throw error;
    return data ?? [];
  }

  #now() {
    return new Date().toISOString();
  }
}

module.exports = new PartitionedJobRepository();