'use strict';

/**
 * src/modules/source-intelligence/repositories/sourceRegistry.repository.js
 *
 * Persistence-only repository for the SIM source registry.
 *
 * Extends the shared BaseRepository (src/repositories/BaseRepository.js) so
 * SIM inherits the platform's existing soft-delete / audit-column / camel<->
 * snake conventions rather than reinventing them. All business logic
 * (trust scoring, governance transitions, health rollups) lives in the
 * service layer — this file only talks to Supabase.
 */

const BaseRepository = require('../../../repositories/BaseRepository');
const { supabase } = require('../../../config/supabase');
const logger = require('../../../utils/logger');
const { TABLES } = require('../models/source.model');

class SourceRegistryRepository extends BaseRepository {
  constructor() {
    super(TABLES.SOURCES);
  }

  /**
   * Sources are unique by (sourceType, apiEndpoint || website || displayName)
   * in practice, but the authoritative uniqueness key enterprises expect is
   * an explicit external identifier when one exists (e.g. a government
   * dataset ID), falling back to endpoint/website.
   */
  async findByExternalKey({ apiEndpoint, website, displayName }) {
    let query = this.db
      .from(this.table)
      .select('*')
      .eq('soft_deleted', false)
      .limit(1);

    if (apiEndpoint) {
      query = query.eq('api_endpoint', apiEndpoint);
    } else if (website) {
      query = query.eq('website', website);
    } else if (displayName) {
      query = query.eq('display_name', displayName);
    } else {
      return null;
    }

    const { data, error } = await query.maybeSingle();
    this._throwDbError(error, 'findByExternalKey');
    return data ? this._normalize(data) : null;
  }

  /**
   * Enterprise search across the registry: category, subcategory, source
   * type, status, trust range, free-text over display name / description.
   */
  async search({
    category,
    subcategory,
    sourceType,
    status,
    minTrustScore,
    ownerId,
    query: textQuery,
    // Enterprise Enhancement 2/3/6 — additive filters. Each targets a
    // JSONB/array column, so a source only matches when it has actually
    // declared the requested domain/entity/connector.
    knowledgeDomain,
    canonicalEntity,
    connectorType,
    page = 1,
    pageSize = 25,
  } = {}) {
    let q = this.db
      .from(this.table)
      .select('*', { count: 'exact' })
      .eq('soft_deleted', false);

    if (category) q = q.eq('category', category);
    if (subcategory) q = q.eq('subcategory', subcategory);
    if (sourceType) q = q.eq('source_type', sourceType);
    if (status) q = q.eq('status', status);
    if (ownerId) q = q.eq('owner', ownerId);
    if (Number.isFinite(minTrustScore)) {
      q = q.gte('trust_score', minTrustScore);
    }
    if (knowledgeDomain) q = q.contains('knowledge_domains', [knowledgeDomain]);
    if (canonicalEntity) q = q.contains('canonical_entity_coverage', [canonicalEntity]);
    if (connectorType) q = q.contains('connector_compatibility', [connectorType]);
    if (textQuery) {
      q = q.or(
        `display_name.ilike.%${textQuery}%,description.ilike.%${textQuery}%`
      );
    }

    const safePage = Math.max(1, Number(page) || 1);
    const safePageSize = Math.min(100, Math.max(1, Number(pageSize) || 25));
    const from = (safePage - 1) * safePageSize;
    const to = from + safePageSize - 1;

    q = q.order('updated_at', { ascending: false }).range(from, to);

    const { data, error, count } = await q;
    this._throwDbError(error, 'search');

    return {
      docs: (data ?? []).map((row) => this._normalize(row)),
      count: count ?? 0,
      page: safePage,
      pageSize: safePageSize,
    };
  }

  async listByStatus(status, { limit = 500 } = {}) {
    const { data, error } = await this.db
      .from(this.table)
      .select('*')
      .eq('soft_deleted', false)
      .eq('status', status)
      .limit(limit);

    this._throwDbError(error, 'listByStatus', { status });
    return (data ?? []).map((row) => this._normalize(row));
  }

  /**
   * Atomic-ish trust/reliability score write, separated from the general
   * update() path so score recalculation jobs don't require callers to
   * round-trip the full source payload.
   */
  async updateScores(id, { trustScore, reliabilityScore }, userId = 'system') {
    const payload = { updated_at: this._now(), updated_by: userId };
    if (Number.isFinite(trustScore)) payload.trust_score = trustScore;
    if (Number.isFinite(reliabilityScore)) {
      payload.reliability_score = reliabilityScore;
    }

    const { data, error } = await this.db
      .from(this.table)
      .update(payload)
      .eq('id', id)
      .eq('soft_deleted', false)
      .select('*')
      .single();

    this._throwDbError(error, 'updateScores', { id });
    return this._normalize(data);
  }
}

module.exports = new SourceRegistryRepository();
module.exports.SourceRegistryRepository = SourceRegistryRepository;
