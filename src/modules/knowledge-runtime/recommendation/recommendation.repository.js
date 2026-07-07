'use strict';

/**
 * modules/knowledge-runtime/recommendation/recommendation.repository.js
 *
 * Data access for RecommendationService, per RUNTIME_CLASS_REFERENCE.md §3's
 * `recommendationRepository — new, persists recommendation runs/results for
 * audit and re-serve`.
 *
 * CONFIRMED TABLE: `intelligence_recommendations`
 * (`supabase/migrations/20260608000001_intelligence_foundation_layer.sql`
 * §5), reachable through `BaseRepository` like every other repository in
 * this module — no second data-access pattern introduced (Objective 5/8).
 *
 * WRITE-PATH SCHEMA GAP (documented, not silently worked around — same
 * discipline as `knowledge.repository.js`'s skill-cluster-membership note
 * and `studentIntelligence.service.js`'s `notSourced(...)` fields):
 *
 * `intelligence_recommendations` enforces, as NOT NULL / CHECK columns:
 *   - `pipeline_run_id`      NOT NULL, FK -> intelligence_pipeline_runs(id)
 *   - `rank`                 NOT NULL, CHECK 1..20
 *   - `recommendation_score` NOT NULL, CHECK 0..100
 *   - `explanation_text`     NOT NULL, CHECK 10..1000 chars
 *
 * WP-IMP-04 Objective 3 explicitly prohibits this WP from producing a
 * pipeline-governed run, a rank, a score, or an explanation ("Do NOT score.
 * Do NOT rank. ... Do NOT explain."). Inserting a row here would require
 * fabricating exactly those four values to satisfy the schema's
 * constraints — which is worse than not persisting, since it would present
 * invented numbers/text as governed output. `RecommendationService`
 * therefore does not call `create()` from its deterministic candidate path
 * in this WP; `create()`/`findByEntity()` are implemented and exercised by
 * tests so the repository is ready the moment a future WP wires a real
 * pipeline run, score, and explanation through here (Validation/
 * Explainability services, per the frozen composition order). Flagged, not
 * silently skipped.
 *
 * `recordFeedback()` on `RecommendationService` has the same gap one level
 * further: no feedback/acceptance table exists anywhere in the inspected
 * schema (confirmed by migration grep — see IMPLEMENTATION_REPORT.md). No
 * write method for feedback is implemented here for the same reason.
 *
 * READ-PATH SCHEMA NOTE: `intelligence_recommendations` has no
 * `soft_deleted` column (confirmed absent from its `CREATE TABLE`, unlike
 * the four `cms_*` tables `knowledge.repository.js` reads, which do have
 * one). `BaseRepository.find()`/`findById()` both add a `.eq('soft_deleted',
 * false)` filter unless called with `{ includeDeleted: true }` — so
 * `findByEntity()` below passes that option explicitly. This is not
 * "including soft-deleted rows" (there is no such concept on this table);
 * it is working around a filter this table's schema doesn't support,
 * documented so a future reader doesn't mistake it for a data-visibility
 * choice.
 */

const BaseRepository = require('../../../repositories/BaseRepository');

const TABLE_NAME = 'intelligence_recommendations';

class RecommendationRepository extends BaseRepository {
  constructor() {
    super(TABLE_NAME);
  }

  /**
   * Read back previously-persisted recommendation rows for an entity.
   * Confirmed-safe today (SELECT only) even though the write path is
   * deferred — supports a future `explainable()`/audit flow once rows
   * exist.
   *
   * @param {string} entityId
   * @param {{ entityType?: string, outputType?: string, limit?: number }} [options]
   * @returns {Promise<object[]>}
   */
  async findByEntity(entityId, { entityType = 'student', outputType = null, limit = 20 } = {}) {
    if (!entityId) return [];

    const filters = [
      { field: 'entityId', op: '==', value: entityId },
      { field: 'entityType', op: '==', value: entityType },
    ];

    if (outputType) {
      filters.push({ field: 'outputType', op: '==', value: outputType });
    }

    // includeDeleted: true — see "READ-PATH SCHEMA NOTE" above. This table
    // has no soft_deleted column; without this flag BaseRepository.find()
    // would filter on a column that doesn't exist.
    const { docs } = await this.find(filters, { limit, includeDeleted: true });
    return docs;
  }
}

module.exports = { RecommendationRepository, TABLE_NAME };
