'use strict';

/**
 * src/modules/source-intelligence/services/sourceRelationship.service.js
 *
 * Enterprise Enhancement 8 — Source Relationship Model.
 *
 * Business rules for relating two sources to each other (parent/child,
 * mirror, backup, depends_on, successor, replaces, alternative). This
 * enables future orchestration/failover in COM: e.g. "if the primary
 * salary source goes unhealthy, does it have a backup or mirror COM can
 * fail over to?"
 *
 * SIM does not perform failover itself — it only records and exposes the
 * relationship graph. Acting on it is a COM concern, same as capability
 * profiles and connector compatibility.
 */

const relationshipRepo = require('../repositories/sourceRelationship.repository');
const sourceRegistryRepo = require('../repositories/sourceRegistry.repository');
const auditRepo = require('../repositories/sourceAudit.repository');
const simErrors = require('../errors/sim.errors');
const simEvents = require('../events/sim.events');
const { isValidRelationshipType } = require('../models/source.model');
const logger = require('../../../utils/logger');

async function addRelationship(
  sourceId,
  { relatedSourceId, relationshipType, notes = null },
  { actorId = 'system' } = {}
) {
  if (!isValidRelationshipType(relationshipType)) {
    throw simErrors.badRequest('relationshipType is not a recognized SIM relationship type.');
  }

  if (!relatedSourceId) {
    throw simErrors.badRequest('relatedSourceId is required.');
  }

  if (sourceId === relatedSourceId) {
    throw simErrors.badRequest('A source cannot have a relationship with itself.');
  }

  const [source, relatedSource] = await Promise.all([
    sourceRegistryRepo.findById(sourceId),
    sourceRegistryRepo.findById(relatedSourceId),
  ]);

  if (!source) throw simErrors.notFound('Source not found.');
  if (!relatedSource) throw simErrors.notFound('relatedSourceId does not reference an existing source.');

  const existing = await relationshipRepo.findExact({ sourceId, relatedSourceId, relationshipType });
  if (existing) {
    throw simErrors.conflict(
      `A '${relationshipType}' relationship from this source to that source already exists.`,
      undefined,
      { relationshipId: existing.id }
    );
  }

  const created = await relationshipRepo.create(
    { sourceId, relatedSourceId, relationshipType, notes },
    actorId
  );

  await auditRepo.record({
    sourceId,
    action: 'RELATIONSHIP_ADDED',
    actorId,
    afterState: created,
  });

  await simEvents.emit(simEvents.SIM_EVENT_TYPES.SOURCE_RELATIONSHIP_ADDED, {
    sourceId,
    relatedSourceId,
    relationshipType,
  });

  logger.info('[SIM.relationships] relationship added', {
    sourceId,
    relatedSourceId,
    relationshipType,
  });

  return created;
}

async function listRelationships(sourceId) {
  const source = await sourceRegistryRepo.findById(sourceId);
  if (!source) throw simErrors.notFound();

  return relationshipRepo.listForSource(sourceId);
}

async function removeRelationship(sourceId, relationshipId, { actorId = 'system' } = {}) {
  const relationship = await relationshipRepo.findById(relationshipId);
  if (!relationship || relationship.sourceId !== sourceId) {
    throw simErrors.notFound('Relationship not found for this source.');
  }

  const removed = await relationshipRepo.remove(relationshipId);

  await auditRepo.record({
    sourceId,
    action: 'RELATIONSHIP_REMOVED',
    actorId,
    beforeState: relationship,
  });

  await simEvents.emit(simEvents.SIM_EVENT_TYPES.SOURCE_RELATIONSHIP_REMOVED, {
    sourceId,
    relatedSourceId: relationship.relatedSourceId,
    relationshipType: relationship.relationshipType,
  });

  return removed;
}

module.exports = {
  addRelationship,
  listRelationships,
  removeRelationship,
};
