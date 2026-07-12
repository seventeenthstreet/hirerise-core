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
  // automation_jobs columns (see supabase/migrations/000_initial_schema.sql +
  // 20260712073230_add_resume_id_to_automation_jobs.sql): id, user_id, status,
  // attempts, max_attempts, worker_id, result, idempotency_key, resume_id,
  // created_at, updated_at, claimed_at, completed_at, failed_at, deleted_at,
  // last_error_code, last_error_message. There is no "type" or "input" column.
  //
  // createJob previously did `{ id, ...jobData, status: 'pending', ... }`,
  // spreading the caller's raw camelCase object (which includes keys like
  // `type`, `userId`, `resumeId`, `idempotencyKey`, and — from the
  // salary/career controllers — `input`) straight into the insert body.
  // None of those camelCase keys match real columns (the real columns are
  // snake_case), and `type`/`input` have no column at all. PostgREST rejects
  // unknown columns with PGRST204 ("Could not find the 'X' column ... in the
  // schema cache") — see 20260520000001_add_engine_version_to_sessions.sql
  // for a prior instance of the exact same failure mode in this codebase.
  // Net effect: `user_id` and `idempotency_key` were never actually being
  // persisted correctly, which is the root cause of "silently disabled
  // duplicate detection" — the missing findByIdempotencyKey method (fixed
  // below) could never have found a match anyway, because no row ever had
  // those columns populated. Fixed by mapping only the fields that have real
  // columns; `type`/`input` are intentionally dropped (no column exists for
  // them, and adding one is out of scope for this fix).
  async createJob(jobId, jobData = {}) {
    const safeJobId = normalizeId(jobId, 'jobId');
    const { userId = null, idempotencyKey = null, resumeId = null } = jobData;

    await execute(
      supabase.from('automation_jobs').insert({
        id: safeJobId,
        user_id: userId,
        idempotency_key: idempotencyKey,
        resume_id: resumeId,
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

  // Restores the idempotency lookup that api-service/src/controllers/
  // resume.controller.js, salary.controller.js, and career.controller.js all
  // already call as `jobRepo.findByIdempotencyKey?.(userId, idempotencyKey)`.
  // The `?.` made the missing method fail silently instead of erroring.
  //
  // Reuses idx_automation_jobs_user_idempotency (user_id, idempotency_key,
  // created_at DESC), which already exists in the schema — no migration
  // needed for this lookup itself. Matches the same active-job status filter
  // ('pending'/'processing') used by getPendingJobsForUser, since the intent
  // (per the resume controller's existing comment) is to reuse an
  // already-in-flight submission, not a finished or dead one.
  async findByIdempotencyKey(userId, idempotencyKey) {
    const safeUserId = normalizeId(userId, 'userId');
    const safeIdempotencyKey = normalizeId(idempotencyKey, 'idempotencyKey');

    const row = await execute(
      supabase
        .from('automation_jobs')
        .select('id, resume_id, status, created_at')
        .eq('user_id', safeUserId)
        .eq('idempotency_key', safeIdempotencyKey)
        .in('status', ['pending', 'processing'])
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      { method: 'findByIdempotencyKey' }
    );

    if (!row) return null;

    return {
      id: row.id,
      resumeId: row.resume_id ?? null,
      status: row.status,
      createdAt: row.created_at,
    };
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