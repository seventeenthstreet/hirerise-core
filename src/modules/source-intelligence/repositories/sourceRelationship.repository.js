'use strict';

/**
 * src/modules/source-intelligence/repositories/sourceRelationship.repository.js
 *
 * Enterprise Enhancement 8 — Source Relationship Model.
 *
 * Persistence-only repository for directed relationships between two SIM
 * sources (parent/child, mirror, backup, depends_on, successor, replaces,
 * alternative). Modeled as its own table rather than an array column on
 * sim_sources so that:
 *   - referential integrity is enforced by FK constraints (a relationship
 *     can never point at a source that doesn't exist / has been hard
 *     deleted),
 *   - "what points at me" queries (failover, dependency graphs) are cheap
 *     indexed lookups instead of full-table array scans,
 *   - relationship rows carry their own audit columns (who added it, when)
 *     without bloating the source row's update history.
 *
 * All business rules (no self-relationships, no exact duplicates, source
 * existence checks) live in sourceRelationship.service.js — this file only
 * talks to Supabase.
 */

const { supabase } = require('../../../config/supabase');
const logger = require('../../../utils/logger');
const { TABLES } = require('../models/source.model');

function throwIfError(error, context, meta = {}) {
  if (!error) return;

  logger.error(`[SourceRelationshipRepository] ${context}`, {
    ...meta,
    message: error.message,
    details: error.details,
    hint: error.hint,
    code: error.code,
  });

  throw error;
}

function normalize(row) {
  if (!row) return null;
  return {
    id: row.id,
    sourceId: row.source_id,
    relatedSourceId: row.related_source_id,
    relationshipType: row.relationship_type,
    notes: row.notes ?? null,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

async function create({ sourceId, relatedSourceId, relationshipType, notes = null }, userId = 'system') {
  const row = {
    source_id: sourceId,
    related_source_id: relatedSourceId,
    relationship_type: relationshipType,
    notes,
    created_at: new Date().toISOString(),
    created_by: userId,
  };

  const { data, error } = await supabase
    .from(TABLES.SOURCE_RELATIONSHIPS)
    .insert(row)
    .select('*')
    .single();

  throwIfError(error, 'create', { sourceId, relatedSourceId, relationshipType });
  return normalize(data);
}

async function findExact({ sourceId, relatedSourceId, relationshipType }) {
  const { data, error } = await supabase
    .from(TABLES.SOURCE_RELATIONSHIPS)
    .select('*')
    .eq('source_id', sourceId)
    .eq('related_source_id', relatedSourceId)
    .eq('relationship_type', relationshipType)
    .maybeSingle();

  throwIfError(error, 'findExact', { sourceId, relatedSourceId, relationshipType });
  return normalize(data);
}

/**
 * All relationships involving a source, in either direction — the outbound
 * edges it declared (source_id = sourceId) and the inbound edges other
 * sources declared pointing at it (related_source_id = sourceId). Callers
 * that only care about one direction can filter the `direction` field on
 * the returned rows.
 */
async function listForSource(sourceId, { limit = 200 } = {}) {
  const [outboundResult, inboundResult] = await Promise.all([
    supabase
      .from(TABLES.SOURCE_RELATIONSHIPS)
      .select('*')
      .eq('source_id', sourceId)
      .order('created_at', { ascending: false })
      .limit(limit),
    supabase
      .from(TABLES.SOURCE_RELATIONSHIPS)
      .select('*')
      .eq('related_source_id', sourceId)
      .order('created_at', { ascending: false })
      .limit(limit),
  ]);

  throwIfError(outboundResult.error, 'listForSource:outbound', { sourceId });
  throwIfError(inboundResult.error, 'listForSource:inbound', { sourceId });

  const outbound = (outboundResult.data ?? []).map((row) => ({
    ...normalize(row),
    direction: 'outbound',
  }));
  const inbound = (inboundResult.data ?? []).map((row) => ({
    ...normalize(row),
    direction: 'inbound',
  }));

  return [...outbound, ...inbound];
}

async function findById(relationshipId) {
  const { data, error } = await supabase
    .from(TABLES.SOURCE_RELATIONSHIPS)
    .select('*')
    .eq('id', relationshipId)
    .maybeSingle();

  throwIfError(error, 'findById', { relationshipId });
  return normalize(data);
}

async function remove(relationshipId) {
  const { data, error } = await supabase
    .from(TABLES.SOURCE_RELATIONSHIPS)
    .delete()
    .eq('id', relationshipId)
    .select('*')
    .maybeSingle();

  throwIfError(error, 'remove', { relationshipId });
  return normalize(data);
}

module.exports = {
  create,
  findExact,
  findById,
  listForSource,
  remove,
};
