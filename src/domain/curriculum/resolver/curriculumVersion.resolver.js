'use strict';

/**
 * @file src/domain/curriculum/resolver/curriculumVersion.resolver.js
 *
 * HireRise Curriculum Architecture — Phase 2 / P2.1
 * `resolve_curriculum_version(board_id, region_id?, class, as_of_date)`
 *
 * Server-authoritative resolution of which curriculum_versions row
 * applies for a given board, optional region, and date. This is the only
 * place in the codebase that is allowed to decide "which curriculum
 * applies" — per architecture-lock rule 8/9, the client never supplies
 * curriculum_version_id directly, and no other module should re-derive
 * this decision independently.
 *
 * Named `resolver/`, mirroring the existing precedent at
 * domain/permission/resolver/rolePermission.resolver.js (class with a
 * `resolve()` method + a convenience singleton export). Unlike that
 * resolver, this one is not a pure in-memory lookup — it reads
 * curriculum_versions via ../repository/curriculumVersion.repository.js
 * — so its constructor accepts injectable dependencies (repository,
 * supabase client) for testability, following the same
 * dependency-injection shape as tests/contract's service tests
 * (e.g. knowledgeService.contract.test.js's injected fake repository).
 *
 * RESOLUTION ALGORITHM (architecture-lock rules 1–6):
 *   1. Fetch every published/archived curriculum_versions row for
 *      board_id (draft is excluded at the repository/query level — rule
 *      1 — AND independently re-checked here against RESOLVABLE_STATUSES
 *      before any row is considered. This is deliberate belt-and-braces,
 *      not duplicated authority: rule 1 ("draft is NEVER resolvable") is
 *      stated as a resolution rule, and rule 9 makes this resolver the
 *      sole owner of the resolution decision, so the guarantee is made
 *      here directly rather than resting entirely on a filter clause in
 *      a different file. It reads the same constant the repository
 *      enforces, so there is one source of truth for "which statuses are
 *      resolvable," not two independently-maintained lists.
 *   2. Keep only rows whose [effective_from, effective_to] window covers
 *      asOfDate (rule 4). Both bounds are treated as inclusive: a row is
 *      effective on asOfDate when
 *      effective_from <= asOfDate <= effective_to (or effective_to is
 *      NULL, i.e. open-ended — rule/test F). The schema's own
 *      chk_curriculum_versions_effective_range constraint only requires
 *      effective_to > effective_from and does not otherwise specify
 *      inclusive/exclusive semantics, so this is a documented modelling
 *      choice, not a schema-given fact — flagged here for anyone
 *      revisiting it.
 *   3. Split the effective rows into "region-specific"
 *      (region_id === the requested regionId) and "board-wide"
 *      (region_id IS NULL). If a regionId was supplied AND at least one
 *      region-specific row is effective, region-specific wins outright
 *      over every board-wide row, regardless of dates (rule 3) — the
 *      board-wide pool is not even considered as a fallback within the
 *      same request once a region-specific match exists.
 *   4. Within whichever pool is in play, pick the single latest
 *      applicable row deterministically (rule 5): the row with the
 *      greatest effective_from wins; ties broken by the greatest
 *      published_at, then by id (lexicographic UUID compare) as a final,
 *      always-available tiebreaker so the result is never ambiguous.
 *   5. If nothing survives step 3/4, throw
 *      CurriculumConfigurationMissingError (rule 7) — never invent or
 *      fall back to any other row.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO (rule 6 / "do not invent
 * architecture"):
 *   - Never reads academic_boards.board_type, academic_streams,
 *     subject_stream_map, or any legacy taxonomy table to infer a
 *     version. The only inputs to the algorithm are boardId, regionId,
 *     and asOfDate, plus the curriculum_versions rows themselves.
 *   - `class` (the grade/class-level parameter named in the architecture
 *     lock's conceptual signature) is accepted as `classLabel` for
 *     signature compatibility with that conceptual API, but
 *     curriculum_versions (the actual, deployed Phase 1 schema) carries
 *     no class/grade column at all — there is nothing on this table for
 *     a class value to filter against. Silently inventing a class-based
 *     filter here (e.g. matching against some other table by guesswork)
 *     would itself be exactly the kind of unrequested architecture rule
 *     6 prohibits, so classLabel is validated (if provided, must be a
 *     non-empty string) but otherwise unused. If a future phase adds
 *     class-scoping to curriculum_versions (or a related table), this is
 *     the one place that would need to change.
 *   - "Region not belonging to a board" (test matrix item J) is not a
 *     separate rule this resolver enforces, because no such relationship
 *     is modelled anywhere in the schema: curriculum_regions has no FK to
 *     academic_boards, and the only place board_id and region_id are
 *     ever associated is on a curriculum_versions row itself. So a
 *     regionId that has simply never been used with this board produces
 *     zero region-specific candidates — the algorithm falls through to
 *     the board-wide pool exactly as it would for any other regionId
 *     with no matches, per step 3 above. No board-region ownership table
 *     is invented to special-case this.
 */

const {
  findResolvableCurriculumVersionsForBoard,
  RESOLVABLE_STATUSES,
} = require('../repository/curriculumVersion.repository');
const {
  InvalidCurriculumResolutionInputError,
  CurriculumConfigurationMissingError,
} = require('../curriculum.errors');

// Lazy require, matching the existing convention in
// domain/permission/repository/permission.repository.js — avoids a
// load-order dependency on config/supabase.js at module-require time and
// keeps this module easily mockable in tests without touching real env.
function getDefaultSupabase() {
  return require('../../../config/supabase').supabase;
}

/**
 * @typedef {Object} CurriculumVersionResolutionInput
 * @property {string} boardId
 * @property {string|null} [regionId]
 * @property {string|null} [classLabel] - accepted, currently unused; see file header
 * @property {string|Date} asOfDate
 */

/**
 * @typedef {Object} CurriculumVersionResolution
 * @property {string} id
 * @property {string} boardId
 * @property {string|null} regionId
 * @property {string} versionLabel
 * @property {'published'|'archived'} status
 * @property {string} effectiveFrom
 * @property {string|null} effectiveTo
 * @property {string|null} ncertRelationship
 * @property {boolean} matchedRegionSpecific
 */

function requireNonEmptyString(value, argName) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidCurriculumResolutionInputError(`${argName} must be a non-empty string`, {
      argName,
      received: value,
    });
  }
  return value;
}

function parseAsOfDate(asOfDate) {
  const parsed = asOfDate instanceof Date ? asOfDate : new Date(asOfDate);
  if (Number.isNaN(parsed.getTime())) {
    throw new InvalidCurriculumResolutionInputError('asOfDate must be a valid date', {
      received: asOfDate,
    });
  }
  return parsed;
}

function isEffectiveOn(row, asOfDate) {
  const effectiveFrom = new Date(row.effective_from);
  if (asOfDate.getTime() < effectiveFrom.getTime()) {
    return false;
  }
  if (row.effective_to !== null && row.effective_to !== undefined) {
    const effectiveTo = new Date(row.effective_to);
    if (asOfDate.getTime() > effectiveTo.getTime()) {
      return false;
    }
  }
  return true;
}

/**
 * Deterministic "pick the single latest applicable row" comparator.
 * Highest effective_from wins; ties broken by highest published_at (a
 * later-published row of the same effective_from is treated as the more
 * current one); a final id compare guarantees a total order even in the
 * pathological case where both are also equal.
 */
function selectLatest(rows) {
  const sorted = [...rows].sort((a, b) => {
    const fromDiff = new Date(b.effective_from).getTime() - new Date(a.effective_from).getTime();
    if (fromDiff !== 0) return fromDiff;

    const bPublished = b.published_at ? new Date(b.published_at).getTime() : -Infinity;
    const aPublished = a.published_at ? new Date(a.published_at).getTime() : -Infinity;
    const publishedDiff = bPublished - aPublished;
    if (publishedDiff !== 0) return publishedDiff;

    return String(a.id).localeCompare(String(b.id));
  });
  return sorted[0];
}

function toResolution(row, { matchedRegionSpecific }) {
  return Object.freeze({
    id: row.id,
    boardId: row.board_id,
    regionId: row.region_id,
    versionLabel: row.version_label,
    status: row.status,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    ncertRelationship: row.ncert_relationship,
    matchedRegionSpecific,
  });
}

class CurriculumVersionResolver {
  /**
   * @param {Object} [deps]
   * @param {import('@supabase/supabase-js').SupabaseClient} [deps.supabase]
   * @param {(supabase: object, boardId: string) => Promise<Array<object>>} [deps.findResolvableCurriculumVersionsForBoard]
   */
  constructor({ supabase, findResolvableCurriculumVersionsForBoard: findFn } = {}) {
    this._supabase = supabase ?? null;
    this._findResolvableCurriculumVersionsForBoard = findFn ?? findResolvableCurriculumVersionsForBoard;
  }

  _getSupabase() {
    return this._supabase ?? getDefaultSupabase();
  }

  /**
   * @param {CurriculumVersionResolutionInput} input
   * @returns {Promise<CurriculumVersionResolution>}
   * @throws {InvalidCurriculumResolutionInputError}
   * @throws {CurriculumConfigurationMissingError}
   * @throws {import('../curriculum.errors').CurriculumVersionRepositoryError}
   */
  async resolve({ boardId, regionId = null, classLabel = null, asOfDate } = {}) {
    requireNonEmptyString(boardId, 'boardId');

    if (regionId !== null && regionId !== undefined) {
      requireNonEmptyString(regionId, 'regionId');
    } else {
      regionId = null;
    }

    // Accepted for conceptual-signature parity; intentionally unused —
    // see the "WHAT THIS DELIBERATELY DOES NOT DO" section above.
    if (classLabel !== null && classLabel !== undefined) {
      requireNonEmptyString(classLabel, 'classLabel');
    }

    const asOfDateObj = parseAsOfDate(asOfDate);

    const supabase = this._getSupabase();
    const candidates = await this._findResolvableCurriculumVersionsForBoard(supabase, boardId);

    const effective = candidates.filter(
      (row) => RESOLVABLE_STATUSES.includes(row.status) && isEffectiveOn(row, asOfDateObj),
    );

    const regionSpecific = regionId ? effective.filter((row) => row.region_id === regionId) : [];
    const boardWide = effective.filter((row) => row.region_id === null || row.region_id === undefined);

    const usingRegionSpecific = regionSpecific.length > 0;
    const pool = usingRegionSpecific ? regionSpecific : boardWide;

    if (pool.length === 0) {
      throw new CurriculumConfigurationMissingError(
        'no published/archived curriculum_versions row is effective for the given board/region/date',
        { boardId, regionId, asOfDate: asOfDateObj.toISOString() },
      );
    }

    const selected = selectLatest(pool);

    return toResolution(selected, { matchedRegionSpecific: usingRegionSpecific });
  }
}

const curriculumVersionResolver = new CurriculumVersionResolver();

/**
 * Convenience function form, matching the "resolve" naming used
 * throughout this WP. Delegates to the shared singleton unless a
 * dependency override is supplied.
 *
 * @param {CurriculumVersionResolutionInput} input
 * @param {Object} [deps] - see CurriculumVersionResolver constructor
 * @returns {Promise<CurriculumVersionResolution>}
 */
async function resolveCurriculumVersion(input, deps) {
  const resolverInstance = deps ? new CurriculumVersionResolver(deps) : curriculumVersionResolver;
  return resolverInstance.resolve(input);
}

module.exports = {
  CurriculumVersionResolver,
  curriculumVersionResolver,
  resolveCurriculumVersion,
};
