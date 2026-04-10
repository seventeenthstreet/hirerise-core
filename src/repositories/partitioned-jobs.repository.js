'use strict';

const { supabase } = require('../config/supabase');
const logger = require('../utils/logger');

const TABLE = 'automation_jobs';
const CLAIM_RPC = 'claim_automation_job';
const FAIL_RPC = 'fail_automation_job';

class PartitionedJobRepository {
  constructor(db = supabase) {
    this.db = db;
  }

  async createJob(jobId, jobData = {}) {
    const now = this.#now();

    const record = {
      id: jobId,
      ...jobData,
      status: jobData.status ?? 'pending',
      attempts: this.#safeNumber(jobData.attempts, 0),
      max_attempts: this.#safeNumber(jobData.maxAttempts, 5),
      idempotency_key: jobData.idempotencyKey ?? null,
      created_at: jobData.created_at ?? now,
      updated_at: now,
      deleted_at: null,
    };

    const { error } = await this.db
      .from(TABLE)
      .upsert(record, { onConflict: 'id' });

    this.#throwIfError(error, 'createJob', { jobId });

    return { jobId, duplicate: false };
  }

  async claimJob(jobId, workerId) {
    const { data, error } = await this.db.rpc(CLAIM_RPC, {
      p_job_id: jobId,
      p_worker_id: workerId,
    });

    // Wave 1 drift hardening:
    // fallback if RPC deployment lags behind JS rollout.
    if (error && this.#isRpcDrift(error)) {
      logger.warn('[PartitionedJobRepository] claimJob rpc drift fallback', {
        jobId,
        workerId,
        rpc: CLAIM_RPC,
        code: error.code,
        message: error.message,
      });

      return this.#fallbackClaimJob(jobId, workerId);
    }

    this.#throwIfError(error, 'claimJob', { jobId, workerId });
    return data ?? null;
  }

  async completeJob(jobId, result = {}) {
    const now = this.#now();

    const { error } = await this.db
      .from(TABLE)
      .update({
        status: 'complete',
        result,
        completed_at: now,
        updated_at: now,
      })
      .eq('id', jobId)
      .eq('status', 'processing')
      .is('deleted_at', null);

    this.#throwIfError(error, 'completeJob', { jobId });
    return true;
  }

  async failJob(jobId, errorCode, errorMessage) {
    const { data, error } = await this.db.rpc(FAIL_RPC, {
      p_job_id: jobId,
      p_error_code: errorCode,
      p_error_message: errorMessage ?? '',
    });

    if (error && this.#isRpcDrift(error)) {
      logger.warn('[PartitionedJobRepository] failJob rpc drift fallback', {
        jobId,
        rpc: FAIL_RPC,
        code: error.code,
        message: error.message,
      });

      return this.#fallbackFailJob(jobId, errorCode, errorMessage);
    }

    this.#throwIfError(error, 'failJob', { jobId, errorCode });
    return data ?? null;
  }

  async findById(jobId) {
    const { data, error } = await this.db
      .from(TABLE)
      .select('*')
      .eq('id', jobId)
      .is('deleted_at', null)
      .maybeSingle();

    if (error) {
      logger.warn('[PartitionedJobRepository] findById soft-null', {
        jobId,
        code: error.code,
        message: error.message,
      });
      return null;
    }

    return data ?? null;
  }

  async getPendingJobsForUser(userId, limit = 10) {
    const { data, error } = await this.db
      .from(TABLE)
      .select('*')
      .eq('user_id', userId)
      .in('status', ['pending', 'processing'])
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(this.#boundedLimit(limit, 10, 100));

    this.#throwIfError(error, 'getPendingJobsForUser', { userId });
    return data ?? [];
  }

  async countPendingForUser(userId) {
    const { count, error } = await this.db
      .from(TABLE)
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .in('status', ['pending', 'processing'])
      .is('deleted_at', null);

    this.#throwIfError(error, 'countPendingForUser', { userId });
    return count ?? 0;
  }

  async getDeadJobs({ limit = 50 } = {}) {
    const { data, error } = await this.db
      .from(TABLE)
      .select('*')
      .eq('status', 'dead')
      .is('deleted_at', null)
      .order('failed_at', { ascending: false })
      .limit(this.#boundedLimit(limit, 50, 200));

    this.#throwIfError(error, 'getDeadJobs');
    return data ?? [];
  }

  async #fallbackClaimJob(jobId, workerId) {
    const now = this.#now();

    const { data, error } = await this.db
      .from(TABLE)
      .update({
        status: 'processing',
        worker_id: workerId,
        claimed_at: now,
        updated_at: now,
      })
      .eq('id', jobId)
      .eq('status', 'pending')
      .is('deleted_at', null)
      .select('*')
      .maybeSingle();

    this.#throwIfError(error, 'fallbackClaimJob', { jobId, workerId });
    return data ?? null;
  }

  async #fallbackFailJob(jobId, errorCode, errorMessage) {
    const existing = await this.findById(jobId);
    const attempts = this.#safeNumber(existing?.attempts, 0) + 1;
    const maxAttempts = this.#safeNumber(existing?.max_attempts, 5);
    const status = attempts >= maxAttempts ? 'dead' : 'pending';
    const now = this.#now();

    const { data, error } = await this.db
      .from(TABLE)
      .update({
        status,
        attempts,
        last_error_code: errorCode,
        last_error_message: errorMessage ?? '',
        failed_at: now,
        updated_at: now,
      })
      .eq('id', jobId)
      .is('deleted_at', null)
      .select('*')
      .maybeSingle();

    this.#throwIfError(error, 'fallbackFailJob', { jobId, errorCode });
    return data ?? null;
  }

  #safeNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  #boundedLimit(value, fallback, max) {
    const parsed = this.#safeNumber(value, fallback);
    return Math.min(Math.max(parsed, 1), max);
  }

  #isRpcDrift(error) {
    const msg = String(error?.message || '').toLowerCase();
    return (
      error?.code === '42883' ||
      msg.includes('function') ||
      msg.includes('does not exist') ||
      msg.includes('schema cache')
    );
  }

  #throwIfError(error, operation, context = {}) {
    if (!error) return;

    logger.error(`[PartitionedJobRepository] ${operation} failed`, {
      ...context,
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    });

    throw error;
  }

  #now() {
    return new Date().toISOString();
  }
}

module.exports = new PartitionedJobRepository();