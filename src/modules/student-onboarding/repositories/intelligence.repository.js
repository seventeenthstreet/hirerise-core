'use strict';

/**
 * src/modules/student-onboarding/repositories/intelligence.repository.js
 *
 * Phase 3D — Cross-Domain Intelligence Layer
 * INTELLIGENCE REPOSITORIES
 *
 * Provides data access for all five Phase 3D tables:
 *   - SignalRegistryRepository    — intelligence_signal_registry
 *   - StudentSignalVectorRepository — student_signal_vectors
 *   - StudentSignalEvidenceRepository — student_signal_evidence (append-only)
 *   - SignalRelationshipRepository — signal_relationships
 *   - SignalConfidenceRepository  — signal_confidence_models
 *
 * ARCHITECTURE:
 *   All classes extend BaseRepository for consistent query execution,
 *   timeout protection, and structured logging.
 *   The execute() wrapper is inherited — all queries are timeout-safe.
 *
 * STORAGE PRINCIPLE:
 *   StudentSignalEvidenceRepository NEVER updates or soft-deletes rows.
 *   It is APPEND-ONLY. The only delete path is cascade on user deletion.
 */

const { supabase }         = require('../../../config/supabase');
const { BaseRepository }   = require('../../../../shared/repositories/base.repository');
const logger               = require('../../../../shared/logger');
const { AGGREGATION_VERSION, TAXONOMY_VERSION } = require('../constants/intelligence');

// ─────────────────────────────────────────────────────────────────────────────
// SIGNAL REGISTRY REPOSITORY
// READ-ONLY from the onboarding module's perspective.
// Registry rows are seeded via migration and managed by admin tools.
// ─────────────────────────────────────────────────────────────────────────────

class SignalRegistryRepository extends BaseRepository {
  constructor() {
    super('intelligence_signal_registry');
  }

  /**
   * Returns all active (non-deprecated, non-deleted) registry entries.
   * Used by validators and aggregation pipeline to confirm signal keys.
   *
   * @returns {Promise<Object[]>}
   */
  async findAllActive() {
    const rows = await this.findWhere(
      [['deleted_at', '==', null]],
      {
        columns:  'signal_key, taxonomy_version, category, primary_domain, compatible_domains, normalization_strategy, aggregation_compatible, longitudinal_trackable, signal_version',
        limit:    200,
        orderBy:  { field: 'primary_domain', direction: 'asc' },
      },
    );

    // Further filter deprecated signals in memory (deprecated_at IS NULL)
    return (rows ?? []).filter((r) => !r.deprecated_at);
  }

  /**
   * Finds a single registry entry by signal_key and taxonomy_version.
   *
   * @param {string} signalKey
   * @param {string} [taxonomyVersion]
   * @returns {Promise<Object|null>}
   */
  async findBySignalKey(signalKey, taxonomyVersion = TAXONOMY_VERSION) {
    if (!signalKey) return null;

    const query = supabase
      .from(this.table)
      .select('*')
      .eq('signal_key', signalKey)
      .eq('taxonomy_version', taxonomyVersion)
      .is('deleted_at', null)
      .maybeSingle();

    return this._exec(query, 'findBySignalKey', { signalKey, taxonomyVersion });
  }

  /**
   * Returns all signal keys compatible with a given domain.
   * Used by domain normalizers to validate output signal keys.
   *
   * @param {string} domain  — intelligence_domain_enum value
   * @returns {Promise<string[]>}
   */
  async findCompatibleKeys(domain) {
    if (!domain) return [];

    // Supabase supports array containment via @> operator
    const query = supabase
      .from(this.table)
      .select('signal_key')
      .contains('compatible_domains', [domain])
      .is('deleted_at', null)
      .is('deprecated_at', null);

    const rows = await this._exec(query, 'findCompatibleKeys', { domain });
    return (rows ?? []).map((r) => r.signal_key);
  }

  async _exec(query, method, context = {}) {
    let timeoutId;
    try {
      const result = await Promise.race([
        Promise.resolve(query),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            const e = new Error('Query timeout');
            e.code  = 'DB_TIMEOUT';
            reject(e);
          }, 10000);
        }),
      ]);
      clearTimeout(timeoutId);
      const { data, error } = result;
      if (error) {
        logger.error('SignalRegistryRepository error', { method, ...context, message: error.message });
        throw error;
      }
      return data;
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STUDENT SIGNAL VECTOR REPOSITORY
// Upserted at the end of each aggregation run.
// One row per (user_id, aggregation_version).
// ─────────────────────────────────────────────────────────────────────────────

class StudentSignalVectorRepository extends BaseRepository {
  constructor() {
    super('student_signal_vectors');
  }

  /**
   * Returns the current signal vector for a user at the given aggregation version.
   *
   * @param {string} userId
   * @param {string} [aggregationVersion]
   * @returns {Promise<Object|null>}
   */
  async findByUser(userId, aggregationVersion = AGGREGATION_VERSION) {
    if (!userId) return null;

    const query = supabase
      .from(this.table)
      .select('*')
      .eq('user_id', userId)
      .eq('aggregation_version', aggregationVersion)
      .is('deleted_at', null)
      .maybeSingle();

    return this._exec(query, 'findByUser', { userId, aggregationVersion });
  }

  /**
   * Upserts the aggregated signal vector for a student.
   * This is the primary write path — called at the end of aggregation.
   *
   * @param {string} userId
   * @param {import('../signals/cross-domain.aggregator').CrossDomainSignalBundle} bundle
   * @returns {Promise<string>}  — row id
   */
  async upsertVector(userId, bundle) {
    if (!userId || !bundle) throw new Error('upsertVector requires userId and bundle');

    const now = new Date().toISOString();

    const payload = {
      user_id:               userId,
      aggregation_version:   bundle.aggregation_version,
      signal_weights:        bundle.signal_weights,
      domain_vectors:        bundle.domain_vectors,
      evidence_summary:      bundle.evidence_summary,
      confidence_data:       bundle.confidence_data,
      contradiction_metadata: bundle.contradiction_metadata,
      pipeline_run_id:       bundle.pipeline_run_id,
      domains_included:      bundle.domains_included,
      is_complete_vector:    bundle.is_complete_vector,
      aggregated_at:         bundle.aggregated_at ?? now,
      updated_at:            now,
      deleted_at:            null,
    };

    const query = supabase
      .from(this.table)
      .upsert(payload, { onConflict: 'user_id,aggregation_version' })
      .select('id')
      .maybeSingle();

    const result = await this._exec(query, 'upsertVector', { userId });
    return result?.id ?? null;
  }

  async _exec(query, method, context = {}) {
    let timeoutId;
    try {
      const result = await Promise.race([
        Promise.resolve(query),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            const e = new Error('Query timeout'); e.code = 'DB_TIMEOUT'; reject(e);
          }, 10000);
        }),
      ]);
      clearTimeout(timeoutId);
      const { data, error } = result;
      if (error) {
        logger.error('StudentSignalVectorRepository error', { method, ...context, message: error.message });
        throw error;
      }
      return data;
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STUDENT SIGNAL EVIDENCE REPOSITORY
// APPEND-ONLY. No update or soft-delete paths.
// ─────────────────────────────────────────────────────────────────────────────

class StudentSignalEvidenceRepository {
  constructor() {
    this.table = 'student_signal_evidence';
  }

  /**
   * Inserts multiple evidence records in a single batch.
   * This is the ONLY write path — called once per aggregation run.
   *
   * Evidence records are idempotent by (user_id, signal_key, source_reference_id,
   * aggregation_version). Duplicate source references within the same aggregation
   * version are deduplicated BEFORE calling this method (see intelligence.service.js).
   *
   * @param {string} userId
   * @param {import('../signals/domain-normalizers').SignalContribution[]} contributions
   * @returns {Promise<number>}  — count of inserted rows
   */
  async bulkInsertEvidence(userId, contributions) {
    if (!userId || !Array.isArray(contributions) || contributions.length === 0) {
      return 0;
    }

    const now     = new Date().toISOString();
    const payload = contributions.map((c) => ({
      user_id:                userId,
      signal_key:             c.signal_key,
      source_type:            c.source_type,
      source_domain:          c.source_domain,
      source_reference_id:    c.source_reference_id,
      source_reference_table: c.source_reference_table ?? null,
      contribution_weight:    c.contribution_weight,
      raw_confidence:         null, // placeholder
      evidence_metadata:      c.evidence_metadata ?? {},
      taxonomy_version:       c.taxonomy_version    ?? TAXONOMY_VERSION,
      aggregation_version:    c.aggregation_version ?? AGGREGATION_VERSION,
      recorded_at:            now,
    }));

    let timeoutId;
    try {
      const result = await Promise.race([
        supabase.from(this.table).insert(payload),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            const e = new Error('Evidence insert timeout'); e.code = 'DB_TIMEOUT'; reject(e);
          }, 15000);
        }),
      ]);
      clearTimeout(timeoutId);

      const { error } = result;
      if (error) {
        logger.error('StudentSignalEvidenceRepository bulkInsert error', {
          userId,
          count: payload.length,
          message: error.message,
        });
        throw error;
      }

      return payload.length;
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    }
  }

  /**
   * Returns all evidence records for a user + signal_key, ordered by recorded_at DESC.
   * Used by diagnostics and future confidence pipeline.
   *
   * @param {string} userId
   * @param {string} signalKey
   * @param {number} [limit]
   * @returns {Promise<Object[]>}
   */
  async findByUserAndSignal(userId, signalKey, limit = 100) {
    if (!userId || !signalKey) return [];

    let timeoutId;
    try {
      const result = await Promise.race([
        supabase
          .from(this.table)
          .select('*')
          .eq('user_id', userId)
          .eq('signal_key', signalKey)
          .order('recorded_at', { ascending: false })
          .limit(limit),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            const e = new Error('Evidence query timeout'); e.code = 'DB_TIMEOUT'; reject(e);
          }, 10000);
        }),
      ]);
      clearTimeout(timeoutId);
      const { data, error } = result;
      if (error) throw error;
      return data ?? [];
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    }
  }

  /**
   * Returns a deduplication key set for a user, allowing the aggregation
   * pipeline to skip already-recorded source references.
   * Returns a Set of strings: `${signal_key}__${source_reference_id}__${aggregation_version}`
   *
   * @param {string} userId
   * @param {string} [aggregationVersion]
   * @returns {Promise<Set<string>>}
   */
  async getExistingReferenceKeys(userId, aggregationVersion = AGGREGATION_VERSION) {
    if (!userId) return new Set();

    let timeoutId;
    try {
      const result = await Promise.race([
        supabase
          .from(this.table)
          .select('signal_key, source_reference_id, aggregation_version')
          .eq('user_id', userId)
          .eq('aggregation_version', aggregationVersion),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            const e = new Error('Dedup query timeout'); e.code = 'DB_TIMEOUT'; reject(e);
          }, 10000);
        }),
      ]);
      clearTimeout(timeoutId);

      const { data, error } = result;
      if (error) throw error;

      return new Set(
        (data ?? []).map(
          (r) => `${r.signal_key}__${r.source_reference_id}__${r.aggregation_version}`,
        ),
      );
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SIGNAL RELATIONSHIP REPOSITORY
// READ-ONLY from the aggregation pipeline's perspective.
// ─────────────────────────────────────────────────────────────────────────────

class SignalRelationshipRepository extends BaseRepository {
  constructor() {
    super('signal_relationships');
  }

  /**
   * Returns all active relationships.
   *
   * @param {string} [taxonomyVersion]
   * @returns {Promise<Object[]>}
   */
  async findAll(taxonomyVersion = TAXONOMY_VERSION) {
    return this.findWhere(
      [
        ['taxonomy_version', '==', taxonomyVersion],
        ['deleted_at', '==', null],
      ],
      { limit: 500 },
    );
  }

  /**
   * Returns all relationships where signal_key_a or signal_key_b matches.
   *
   * @param {string} signalKey
   * @returns {Promise<Object[]>}
   */
  async findForSignal(signalKey) {
    if (!signalKey) return [];

    let timeoutId;
    try {
      const result = await Promise.race([
        supabase
          .from(this.table)
          .select('*')
          .or(`signal_key_a.eq.${signalKey},signal_key_b.eq.${signalKey}`)
          .is('deleted_at', null),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            const e = new Error('Relationship query timeout'); e.code = 'DB_TIMEOUT'; reject(e);
          }, 10000);
        }),
      ]);
      clearTimeout(timeoutId);
      const { data, error } = result;
      if (error) throw error;
      return data ?? [];
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SIGNAL CONFIDENCE REPOSITORY
// Upserted alongside student_signal_vectors in each aggregation run.
// ─────────────────────────────────────────────────────────────────────────────

class SignalConfidenceRepository extends BaseRepository {
  constructor() {
    super('signal_confidence_models');
  }

  /**
   * Upserts confidence model rows for all signals in a bundle.
   * Called once per aggregation run, after the vector is upserted.
   *
   * @param {string} userId
   * @param {import('../signals/cross-domain.aggregator').CrossDomainSignalBundle} bundle
   * @returns {Promise<number>} — count of upserted rows
   */
  async upsertBundleConfidence(userId, bundle) {
    if (!userId || !bundle?.confidence_data) return 0;

    const now = new Date().toISOString();

    const rows = Object.entries(bundle.confidence_data).map(([signalKey, conf]) => {
      const contradiction = Object.values(bundle.contradiction_metadata ?? {})
        .find((c) => c.signal_a === signalKey || c.signal_b === signalKey);

      return {
        user_id:                    userId,
        signal_key:                 signalKey,
        aggregation_version:        bundle.aggregation_version,
        evidence_count:             conf.evidence_count,
        source_diversity:           conf.source_diversity,
        cross_domain_reinforcement: conf.cross_domain_reinforcement,
        contradiction_severity:     contradiction?.severity ?? 'none',
        composite_confidence:       null, // placeholder
        computed_at:                now,
        updated_at:                 now,
      };
    });

    if (rows.length === 0) return 0;

    let timeoutId;
    try {
      const result = await Promise.race([
        supabase
          .from(this.table)
          .upsert(rows, { onConflict: 'user_id,signal_key,aggregation_version' }),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            const e = new Error('Confidence upsert timeout'); e.code = 'DB_TIMEOUT'; reject(e);
          }, 15000);
        }),
      ]);
      clearTimeout(timeoutId);
      const { error } = result;
      if (error) throw error;
      return rows.length;
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    }
  }

  /**
   * Returns all confidence models for a user.
   *
   * @param {string} userId
   * @param {string} [aggregationVersion]
   * @returns {Promise<Object[]>}
   */
  async findByUser(userId, aggregationVersion = AGGREGATION_VERSION) {
    if (!userId) return [];

    return this.findWhere(
      [
        ['user_id', '==', userId],
        ['aggregation_version', '==', aggregationVersion],
      ],
      { limit: 100 },
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  SignalRegistryRepository,
  StudentSignalVectorRepository,
  StudentSignalEvidenceRepository,
  SignalRelationshipRepository,
  SignalConfidenceRepository,
};
