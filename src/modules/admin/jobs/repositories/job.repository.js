'use strict';

/**
 * job.repository.js — Job Sync Repository (Supabase)
 * MIGRATED: Firestore 'jobs' collection → Supabase 'jobs' table
 *
 * SQL to create the jobs table (run in Supabase SQL Editor):
 *
 * CREATE TABLE IF NOT EXISTS jobs (
 *   job_code     TEXT        PRIMARY KEY,
 *   title        TEXT,
 *   company      TEXT,
 *   location     TEXT,
 *   description  TEXT,
 *   salary_min   BIGINT,
 *   salary_max   BIGINT,
 *   currency     TEXT        DEFAULT 'INR',
 *   source_type  TEXT,
 *   source_url   TEXT,
 *   is_deleted   BOOLEAN     NOT NULL DEFAULT false,
 *   created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *   updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
 * );
 * CREATE INDEX IF NOT EXISTS idx_jobs_deleted ON jobs (is_deleted, updated_at DESC);
 */

const logger = require('../../../../utils/logger');

function getSupabase() { return require('../../../../core/supabaseClient'); }

class JobRepository {

  _normalizeJobCode(jobCode) {
    if (!jobCode || typeof jobCode !== 'string') throw new Error('Invalid jobCode provided');
    return jobCode.trim().toUpperCase().replace(/\//g, '_');
  }

  // Supabase does not need batch objects — we collect records and upsert in bulk.
  // We keep the same interface (createBatch / addUpsertToBatch / commitBatch)
  // so jobSync.service.js needs no changes.
  createBatch() {
    return { _records: [], _isNew: [] };
  }

  addUpsertToBatch(batch, jobData, isNew) {
    const normalizedCode = this._normalizeJobCode(jobData.jobCode);
    batch._records.push({
      job_code:    normalizedCode,
      title:       jobData.title       || null,
      company:     jobData.company     || null,
      location:    jobData.location    || null,
      description: jobData.description || null,
      salary_min:  jobData.salaryMin   || null,
      salary_max:  jobData.salaryMax   || null,
      currency:    jobData.currency    || 'INR',
      source_type: jobData.sourceType  || null,
      source_url:  jobData.sourceUrl   || null,
      is_deleted:  false,
      updated_at:  new Date().toISOString(),
      ...(isNew ? { created_at: new Date().toISOString() } : {}),
    });
  }

  async commitBatch(batch) {
    if (!batch._records.length) return;
    const supabase = getSupabase();

    // Upsert in chunks of 500
    const CHUNK = 500;
    for (let i = 0; i < batch._records.length; i += CHUNK) {
      const chunk = batch._records.slice(i, i + CHUNK);
      const { error } = await supabase
        .from('jobs')
        .upsert(chunk, { onConflict: 'job_code' });
      if (error) {
        logger.error('[JobRepository.commitBatch] Supabase upsert failed', { error: error.message });
        throw new Error(error.message);
      }
    }
    logger.info('[JobRepository] Batch committed', { count: batch._records.length });
  }

  async exists(jobCode) {
    try {
      const supabase = getSupabase();
      const normalized = this._normalizeJobCode(jobCode);
      // HARDENING T2: .single() → .maybeSingle() — job may not exist
      const { data, error } = await supabase
        .from('jobs').select('job_code').eq('job_code', normalized).maybeSingle();
      if (error) throw error;
      return !!data;
    } catch (err) {
      logger.error('[JobRepository.exists]', { jobCode, error: err.message });
      return false;
    }
  }

  async findByJobCode(jobCode) {
    try {
      const supabase = getSupabase();
      const normalized = this._normalizeJobCode(jobCode);
      // HARDENING T2: .single() → .maybeSingle() — job may not exist
      const { data, error } = await supabase
        .from('jobs').select('*').eq('job_code', normalized).maybeSingle();
      if (error) throw error;
      return data || null;
    } catch (err) {
      logger.error('[JobRepository.findByJobCode]', { jobCode, error: err.message });
      return null;
    }
  }
}

module.exports = new JobRepository();