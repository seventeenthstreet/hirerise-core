'use strict';

/**
 * @file src/domain/curriculum/repository/curriculumVersion.repository.js
 *
 * HireRise Curriculum Architecture — Phase 2 / P2.1
 * Curriculum Version Resolution — persistence layer.
 *
 * Reads the `curriculum_versions` table exactly as deployed in Phase 1
 * (supabase/migrations/20260913020000_p1_curriculum_schema_foundation.sql,
 * corrected by .../20260913030000_..._draft_rls.sql and
 * .../20260913040000_..._audit_log_trigger.sql). Does NOT add another
 * version table, does NOT touch curriculum_pathways / subject_group_map /
 * academic_streams — those are out of scope for P2.1 (resolution only).
 *
 * PERSISTENCE ONLY, mirroring domain/permission/repository's Repository
 * Boundaries convention: no business filtering beyond the exact-match
 * board scoping and status allow-list below, no effective-date logic, no
 * region precedence, no "latest version" selection. All of that is
 * resolution business logic and lives in
 * ../resolver/curriculumVersion.resolver.js — this file only fetches
 * candidate rows.
 *
 * WHY FILTERING IS SPLIT THIS WAY (DB vs. in-process):
 * This repository pushes down to Postgres the two filters that are cheap,
 * unambiguous, and safe to express as simple equality/membership
 * predicates: `board_id` and `status IN ('published','archived')`.
 * Effective-date windowing and region-vs-board-wide precedence are
 * deliberately left to the resolver, evaluated in JS over the (typically
 * very small, per-board) result set, rather than expressed as a
 * PostgREST `.or()` filter string built via value interpolation. A
 * config table like this has a handful of versions per board, not a
 * data table — fetching all published/archived rows for one board is
 * cheap, and keeps every date/precedence rule as plain, unit-testable JS
 * in one place instead of split between a filter string and downstream
 * code.
 *
 * SECURITY NOTE — RLS IS NOT IN EFFECT HERE:
 * This repository uses the shared `supabase` client
 * (src/config/supabase.js), which is constructed from
 * SUPABASE_SERVICE_ROLE_KEY — the same client every other repository in
 * this codebase uses (e.g. domain/permission/repository/permission.repository.js).
 * service_role bypasses Postgres RLS entirely, so the
 * `curriculum_versions_public_read` policy (status IN
 * ('published','archived')) added in 20260913030000 does NOT constrain
 * this query. The `.in('status', ['published', 'archived'])` filter
 * below is therefore not a defense-in-depth nicety — it is the ONLY
 * enforcement of "draft is never resolvable" (architecture-lock rule 1)
 * in this code path, and must never be removed or widened.
 */

const logger = require('../../../utils/logger');
const { CurriculumVersionRepositoryError } = require('../curriculum.errors');

const TABLE = 'curriculum_versions';

const RESOLVABLE_STATUSES = Object.freeze(['published', 'archived']);

// Deliberately excludes created_by: the resolver has no need for it, and
// there's no reason to pull an internal actor id through a read path that
// (per Phase 2 scope) may eventually back a student-facing resolution
// endpoint.
const SELECT_COLUMNS =
  'id, board_id, region_id, version_label, status, effective_from, effective_to, ncert_relationship, published_at, archived_at, notes';

/**
 * Fetches every published/archived curriculum_versions row for a given
 * board. Draft rows are excluded at the query level (see security note
 * above) — never returned to any caller of this function under any
 * circumstance.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} boardId
 * @returns {Promise<Array<object>>} raw (snake_case) rows; may be empty
 * @throws {CurriculumVersionRepositoryError} if the query itself fails
 */
async function findResolvableCurriculumVersionsForBoard(supabase, boardId) {
  const { data, error } = await supabase
    .from(TABLE)
    .select(SELECT_COLUMNS)
    .eq('board_id', boardId)
    .in('status', RESOLVABLE_STATUSES);

  if (error) {
    logger.error('[CurriculumVersionRepository] findResolvableCurriculumVersionsForBoard error', {
      boardId,
      error: error.message,
    });
    throw new CurriculumVersionRepositoryError(
      `failed to load curriculum_versions for board ${boardId}: ${error.message}`,
      { boardId },
    );
  }

  return data ?? [];
}

module.exports = {
  RESOLVABLE_STATUSES,
  findResolvableCurriculumVersionsForBoard,
};
