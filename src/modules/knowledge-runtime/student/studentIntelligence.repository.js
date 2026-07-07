'use strict';

/**
 * modules/knowledge-runtime/student/studentIntelligence.repository.js
 *
 * Data access for StudentService (RUNTIME_CLASS_REFERENCE.md §2 calls this
 * `studentIntelligenceRepository`). Persists/reads derived SIM artifacts —
 * NOT student profile/academic/activity CRUD, which stays owned by
 * `education-intelligence` and `student-onboarding` (Objective 3: "no
 * duplicated ownership").
 *
 * Backing table: `intelligence_entity_snapshots` (defined in
 * `supabase/migrations/20260608000001_intelligence_foundation_layer.sql`,
 * confirmed present via schema inspection — not assumed). This table is:
 *   - Immutable: `fn_phase2a_immutable_row()` triggers block UPDATE/DELETE.
 *   - Currently written by nothing in the application layer (`grep`
 *     confirms zero existing references anywhere in `core/src`) — this
 *     repository is the first consumer.
 *   - NOT shaped like BaseRepository's generic governed-table assumption.
 *
 * DOCUMENTED SCHEMA MISMATCH (Objective 10 — not silently worked around):
 * `intelligence_entity_snapshots` has no `soft_deleted`, `status`,
 * `version`, `created_by`, or `updated_by` columns. BaseRepository's
 * `find()`/`findById()` unconditionally filter `WHERE soft_deleted = false`
 * unless `{ includeDeleted: true }` is passed — this repository always
 * passes it for that reason (not to "include deleted rows," which don't
 * exist for an immutable table, but to avoid filtering on a column this
 * table doesn't have). BaseRepository's `create()` unconditionally injects
 * `updated_at`, `created_by`, `updated_by`, `version`, `status`,
 * `soft_deleted` into every insert payload — none of which exist on this
 * table, so `create()` cannot be used here at all; it would fail with a
 * Postgres "column does not exist" error. `insertSnapshot()` below
 * therefore performs a direct, minimal Supabase insert instead of calling
 * `super.create()`, using only the columns this table actually has. This
 * is the same category of finding as WP-IMP-02's AppError argument-order
 * note: BaseRepository encodes an assumption (every table is a generic
 * "governed" table) that doesn't hold universally. Flagged as technical
 * debt for a future maintenance WP, not fixed here.
 */

const crypto = require('crypto');
const BaseRepository = require('../../../repositories/BaseRepository');
const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');

const ENTITY_TYPE_STUDENT = 'student';
const INTELLIGENCE_DOMAIN_STUDENT = 'student';

class StudentIntelligenceRepository extends BaseRepository {
  constructor() {
    super('intelligence_entity_snapshots');
  }

  /**
   * Most recent snapshot for a student (highest `snapshot_sequence`).
   *
   * @param {string} userId — auth.users(id) / entity_id
   * @returns {Promise<object|null>}
   */
  async findLatestSnapshot(userId) {
    if (!userId) return null;

    const { docs } = await this.find(
      [
        { field: 'entityId', op: '==', value: userId },
        { field: 'entityType', op: '==', value: ENTITY_TYPE_STUDENT },
        { field: 'intelligenceDomain', op: '==', value: INTELLIGENCE_DOMAIN_STUDENT },
      ],
      {
        includeDeleted: true, // see header note — this table has no soft_deleted column
        orderBy: { field: 'snapshotSequence', direction: 'desc' },
        limit: 1,
      }
    );

    return docs[0] ?? null;
  }

  /**
   * All snapshots for a student, most recent first — used for trend/delta
   * views (`delta_from_previous` is already computed at write time by
   * whatever produced the snapshot; this method does not recompute it).
   *
   * @param {string} userId
   * @param {{ limit?: number }} [options]
   * @returns {Promise<object[]>}
   */
  async findSnapshotHistory(userId, { limit = 10 } = {}) {
    if (!userId) return [];

    const { docs } = await this.find(
      [
        { field: 'entityId', op: '==', value: userId },
        { field: 'entityType', op: '==', value: ENTITY_TYPE_STUDENT },
        { field: 'intelligenceDomain', op: '==', value: INTELLIGENCE_DOMAIN_STUDENT },
      ],
      {
        includeDeleted: true,
        orderBy: { field: 'snapshotSequence', direction: 'desc' },
        limit,
      }
    );

    return docs;
  }

  /**
   * Insert a new immutable snapshot row.
   *
   * Does NOT call `BaseRepository.create()` — see header note. Requires an
   * already-valid governance chain (`pipelineRunId`, `modelVersionId`)
   * supplied by the caller; this repository does not resolve "the current
   * model version" or fabricate a pipeline run, since no existing code in
   * this repository does that today (confirmed: zero references to
   * `intelligence_entity_snapshots` anywhere in the codebase prior to this
   * WP) and inventing that resolution logic here would be guessing at a
   * process this WP was not asked to design.
   *
   * @param {object} params
   * @param {string} params.userId
   * @param {string} params.pipelineRunId — FK to intelligence_pipeline_runs, caller-supplied
   * @param {string} params.modelVersionId — FK to signal_weight_versions, caller-supplied
   * @param {string} params.snapshotTrigger — one of: onboarding_complete | periodic_scheduled | data_event | manual_request | domain_transition
   * @param {number} params.snapshotSequence — caller-supplied; this repository does not compute the next sequence number
   * @param {object} [params.signalState]
   * @param {object} [params.domainState]
   * @param {number} [params.compositeConfidence]
   * @param {'HIGH'|'MEDIUM'|'LOW'|'NO_DATA'} [params.confidenceTier]
   * @param {number} [params.dataCompleteness]
   * @param {number} [params.activeSignalCount]
   * @param {string[]} [params.domainsIncluded]
   * @param {object|null} [params.deltaFromPrevious]
   * @param {string} params.stateHash — SHA-256 hex digest of canonical(signalState + domainState), 64 chars
   * @returns {Promise<object>}
   */
  async insertSnapshot(params) {
    const {
      userId,
      pipelineRunId,
      modelVersionId,
      snapshotTrigger,
      snapshotSequence,
      signalState = {},
      domainState = {},
      compositeConfidence = 0,
      confidenceTier = 'NO_DATA',
      dataCompleteness = 0,
      activeSignalCount = 0,
      domainsIncluded = [],
      deltaFromPrevious = null,
      stateHash,
    } = params ?? {};

    if (!userId || !pipelineRunId || !modelVersionId || !snapshotTrigger || !snapshotSequence || !stateHash) {
      throw new AppError(
        'insertSnapshot requires userId, pipelineRunId, modelVersionId, snapshotTrigger, snapshotSequence, and stateHash',
        400,
        { params: Object.keys(params ?? {}) },
        ErrorCodes.VALIDATION_ERROR
      );
    }

    const payload = {
      id: crypto.randomUUID(),
      entity_type: ENTITY_TYPE_STUDENT,
      entity_id: userId,
      intelligence_domain: INTELLIGENCE_DOMAIN_STUDENT,
      pipeline_run_id: pipelineRunId,
      model_version_id: modelVersionId,
      snapshot_trigger: snapshotTrigger,
      snapshot_sequence: snapshotSequence,
      signal_state: signalState,
      domain_state: domainState,
      composite_confidence: compositeConfidence,
      confidence_tier: confidenceTier,
      data_completeness: dataCompleteness,
      active_signal_count: activeSignalCount,
      domains_included: domainsIncluded,
      delta_from_previous: deltaFromPrevious,
      state_hash: stateHash,
    };

    const { data, error } = await this.db
      .from(this.table)
      .insert(payload)
      .select('*')
      .single();

    this._throwDbError(error, 'insertSnapshot');
    return this._normalize(data);
  }
}

module.exports = { StudentIntelligenceRepository };
