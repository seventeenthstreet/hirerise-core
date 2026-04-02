'use strict';

/**
 * job.repository.js — Pure Supabase Job Repository
 * Optimized for high-volume bulk sync imports
 */

const logger = require('../../../../utils/logger');

function getSupabase() {
  return require('../../../../config/supabase');
}

class JobRepository {
  _normalizeJobCode(jobCode) {
    if (!jobCode || typeof jobCode !== 'string') {
      throw new Error('Invalid jobCode provided');
    }

    return jobCode
      .trim()
      .toUpperCase()
      .replace(/\//g, '_');
  }

  _mapJobRow(jobData) {
    return {
      job_code: this._normalizeJobCode(jobData.jobCode),
      title: jobData.title || null,
      company: jobData.company || null,
      location: jobData.location || null,
      description: jobData.description || null,
      salary_min: jobData.salaryMin || null,
      salary_max: jobData.salaryMax || null,
      currency: jobData.currency || 'INR',
      source_type: jobData.sourceType || null,
      source_url: jobData.sourceUrl || null,
      is_deleted: false,
      updated_at: new Date().toISOString(),
    };
  }

  /**
   * Native Supabase bulk upsert
   */
  async bulkUpsert(rows) {
    if (!Array.isArray(rows) || rows.length === 0) {
      return 0;
    }

    const supabase = getSupabase();
    const mappedRows = rows.map((row) => this._mapJobRow(row));

    const CHUNK_SIZE = 1000;
    let totalProcessed = 0;

    for (let i = 0; i < mappedRows.length; i += CHUNK_SIZE) {
      const chunk = mappedRows.slice(i, i + CHUNK_SIZE);

      const { data, error } = await supabase
        .from('jobs')
        .upsert(chunk, {
          onConflict: 'job_code',
          ignoreDuplicates: false,
        })
        .select('job_code');

      if (error) {
        logger.error('[JobRepository.bulkUpsert] Supabase upsert failed', {
          error: error.message,
          chunkSize: chunk.length,
        });

        throw new Error(error.message);
      }

      totalProcessed += data?.length || chunk.length;
    }

    logger.info('[JobRepository.bulkUpsert] completed', {
      totalProcessed,
    });

    return totalProcessed;
  }

  async findByJobCode(jobCode) {
    try {
      const supabase = getSupabase();
      const normalized = this._normalizeJobCode(jobCode);

      const { data, error } = await supabase
        .from('jobs')
        .select('*')
        .eq('job_code', normalized)
        .maybeSingle();

      if (error) {
        throw error;
      }

      return data || null;
    } catch (err) {
      logger.error('[JobRepository.findByJobCode]', {
        jobCode,
        error: err.message,
      });

      return null;
    }
  }
}

module.exports = new JobRepository();