'use strict';

/**
 * job.repository.js — Pure Supabase Job Repository
 * Optimized for high-volume bulk sync imports.
 *
 * WP-ADMIN-COMP-06 fixes (repository evidence: supabase/migrations/
 * 000_initial_schema.sql, "public"."jobs" table definition, lines ~8169):
 *
 * 1. getSupabase() bugfix — this previously returned the whole
 *    config/supabase.js module object ({ supabase, getClient, withRetry,
 *    verifyConnection }) instead of the Supabase client itself. Every call
 *    site does `supabase.from(TABLE)`, which throws
 *    `TypeError: supabase.from is not a function` on every single method
 *    in this repository. Same bug class already fixed in
 *    adminCmsSkills.repository.js (WP-ADMIN-03B) and
 *    adminPrincipal.repository.js — fixed here identically.
 *
 * 2. Column mapping bugfix — _mapJobRow() previously wrote to columns that
 *    do not exist on "public"."jobs" (job_code, currency, source_type,
 *    source_url, is_deleted, updated_at). The real table has: id,
 *    external_id, title, company, location, description, skills (jsonb),
 *    experience_level, salary_min, salary_max, salary_currency,
 *    contract_type, redirect_url, source, country, posted_at, fetched_at,
 *    created_at. Any Supabase call with the old mapping would fail with
 *    PGRST204 ("Could not find the 'job_code' column ... in the schema
 *    cache"). Fixed to map onto the real columns, using the closest
 *    authoritative field from the validated sync record shape
 *    (validators/jobSync.validator.js's validateJobRecord output):
 *      jobCode      -> external_id  (admin/source-supplied stable ID)
 *      type         -> contract_type
 *      tags         -> skills (jsonb array)
 *      externalUrl  -> redirect_url
 *      postedAt     -> posted_at
 *      salary.min/max/currency -> salary_min / salary_max / salary_currency
 *    `source` (NOT NULL on the real table) is threaded in by the caller
 *    (jobSync.service.js) from the sync request's sourceType — it is not
 *    part of the per-record payload validateJobRecord produces.
 *
 * 3. bulkUpsert onConflict target — changed from the nonexistent job_code
 *    column to `external_id,source`, matching the real unique index
 *    "jobs_external_source_uq" ON "public"."jobs" (external_id, source)
 *    WHERE external_id IS NOT NULL.
 *
 * 4. findByJobCode() replaced with findByExternalId(externalId, source),
 *    matching the real dedup key. (findByJobCode had no callers anywhere
 *    in the repository — confirmed via repo-wide search — so renaming is
 *    not a breaking change.)
 *
 * 5. list() / findById() added — WP-ADMIN-COMP-06 Admin Job List/Detail.
 *    No admin-facing read path existed for the jobs table before this;
 *    these are new, minimal, read-only additions using the real schema
 *    and the existing indexes (jobs_fetched_at_idx, jobs_source_idx,
 *    jobs_title_idx).
 */

const logger = require('../../../../utils/logger');

function getSupabase() {
  return require('../../../../config/supabase').supabase;
}

const TABLE = 'jobs';

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

class JobRepository {
  _normalizeExternalId(externalId) {
    if (!externalId || typeof externalId !== 'string') {
      throw new Error('Invalid external id provided');
    }

    return externalId.trim().toUpperCase().replace(/\//g, '_');
  }

  _mapJobRow(jobData, { source } = {}) {
    const salary = jobData.salary && typeof jobData.salary === 'object' ? jobData.salary : {};

    return {
      external_id: this._normalizeExternalId(jobData.jobCode),
      title: jobData.title || null,
      company: jobData.company || null,
      location: jobData.location || null,
      description: jobData.description || null,
      skills: Array.isArray(jobData.tags) ? jobData.tags : [],
      contract_type: jobData.type || null,
      salary_min: typeof salary.min === 'number' ? salary.min : null,
      salary_max: typeof salary.max === 'number' ? salary.max : null,
      salary_currency: salary.currency || 'INR',
      redirect_url: jobData.externalUrl || null,
      posted_at: jobData.postedAt || null,
      source: source || 'admin_sync',
    };
  }

  /**
   * Native Supabase bulk upsert.
   *
   * @param {object[]} rows — validated job records (validateJobRecord shape)
   * @param {{ source?: string }} [opts] — sourceType from the triggering
   *   sync request, written to every row's `source` column (NOT NULL,
   *   part of the real jobs_external_source_uq unique key).
   */
  async bulkUpsert(rows, opts = {}) {
    if (!Array.isArray(rows) || rows.length === 0) {
      return 0;
    }

    const supabase = getSupabase();
    const mappedRows = rows.map((row) => this._mapJobRow(row, opts));

    const CHUNK_SIZE = 1000;
    let totalProcessed = 0;

    for (let i = 0; i < mappedRows.length; i += CHUNK_SIZE) {
      const chunk = mappedRows.slice(i, i + CHUNK_SIZE);

      const { data, error } = await supabase
        .from(TABLE)
        .upsert(chunk, {
          onConflict: 'external_id,source',
          ignoreDuplicates: false,
        })
        .select('external_id');

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

  async findByExternalId(externalId, source) {
    try {
      const supabase = getSupabase();
      const normalized = this._normalizeExternalId(externalId);

      let query = supabase.from(TABLE).select('*').eq('external_id', normalized);
      if (source) query = query.eq('source', source);

      const { data, error } = await query.maybeSingle();

      if (error) throw error;

      return data || null;
    } catch (err) {
      logger.error('[JobRepository.findByExternalId]', {
        externalId,
        source,
        error: err.message,
      });

      return null;
    }
  }

  /**
   * WP-ADMIN-COMP-06 — Admin Job List.
   *
   * Read-only, paginated list backed by the real "jobs" table.
   * `search` uses ilike against title/company/location (no full-text
   * search index exists on this table — see jobs_title_idx, a plain
   * btree index — so this is a straightforward ilike, not a ranked
   * search). `source` filters on the exact source column. Ordered by
   * fetched_at desc (jobs_fetched_at_idx), the most recently-ingested
   * jobs first.
   *
   * @returns {Promise<{ items: object[], total: number }>}
   */
  async list({ limit = DEFAULT_LIST_LIMIT, offset = 0, search, source } = {}) {
    const supabase = getSupabase();
    const safeLimit = Math.min(Math.max(Number(limit) || DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
    const safeOffset = Math.max(Number(offset) || 0, 0);

    let query = supabase
      .from(TABLE)
      .select('*', { count: 'exact' })
      .order('fetched_at', { ascending: false })
      .range(safeOffset, safeOffset + safeLimit - 1);

    if (source) {
      query = query.eq('source', source);
    }

    if (search) {
      const term = search.trim().replace(/[%_]/g, '');
      if (term) {
        query = query.or(
          `title.ilike.%${term}%,company.ilike.%${term}%,location.ilike.%${term}%`
        );
      }
    }

    const { data, error, count } = await query;

    if (error) {
      logger.error('[JobRepository.list] Supabase query failed', { error: error.message });
      throw new Error(error.message);
    }

    return { items: data || [], total: count ?? (data || []).length };
  }

  /**
   * WP-ADMIN-COMP-06 — Admin Job Detail.
   *
   * @returns {Promise<object|null>}
   */
  async findById(id) {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) {
      logger.error('[JobRepository.findById] Supabase query failed', { id, error: error.message });
      throw new Error(error.message);
    }

    return data || null;
  }
}

module.exports = new JobRepository();
