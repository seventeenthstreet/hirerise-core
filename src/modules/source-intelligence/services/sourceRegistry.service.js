'use strict';

/**
 * src/modules/source-intelligence/services/sourceRegistry.service.js
 *
 * WP-P2-01 — Source Intelligence Management (SIM)
 *
 * Business layer for the source registry: registration, metadata
 * lifecycle, and reads. Repositories stay persistence-only; this is
 * where "what does it mean to register a source" actually lives.
 *
 * SIM's contract with the rest of Phase-2:
 *   - It is the ONLY writer of sim_sources.
 *   - It never collects, transforms, or publishes knowledge itself.
 *   - It tells COM (via sim.events) when a source becomes eligible /
 *     ineligible for collection. COM decides what to do with that.
 */

const sourceRegistryRepo = require('../repositories/sourceRegistry.repository');
const auditRepo = require('../repositories/sourceAudit.repository');
const governanceService = require('./sourceGovernance.service');
const healthService = require('./sourceHealth.service');
const trustService = require('./sourceTrust.service');
const relationshipService = require('./sourceRelationship.service');
const simEvents = require('../events/sim.events');
const simErrors = require('../errors/sim.errors');
const {
  SOURCE_STATUS,
  APPROVAL_STATUS,
  HEALTH_STATUS,
  sanitizeSourceMetadataPatch,
} = require('../models/source.model');
const logger = require('../../../utils/logger');

// ─────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────

async function registerSource(fields = {}, { actorId = 'system' } = {}) {
  if (!fields?.displayName?.trim()) {
    throw simErrors.badRequest('displayName is required.');
  }
  if (!fields?.sourceType) {
    throw simErrors.badRequest('sourceType is required.');
  }

  const existing = await sourceRegistryRepo.findByExternalKey({
    apiEndpoint: fields.apiEndpoint,
    website: fields.website,
    displayName: fields.displayName,
  });

  if (existing) {
    throw simErrors.conflict(
      `A source already exists with the same ${
        fields.apiEndpoint ? 'apiEndpoint' : fields.website ? 'website' : 'displayName'
      }.`,
      undefined,
      { existingSourceId: existing.id }
    );
  }

  const metadata = sanitizeSourceMetadataPatch(fields);
  const baseTrustScore = trustService.computeBaseTrustScore(metadata);

  const created = await sourceRegistryRepo.create(
    {
      ...metadata,
      owner: metadata.owner || actorId,
      status: SOURCE_STATUS.PENDING_APPROVAL,
      approvalStatus: APPROVAL_STATUS.NOT_SUBMITTED,
      trustScore: baseTrustScore,
      reliabilityScore: null,
      healthStatus: HEALTH_STATUS.UNKNOWN,
      failureCount: 0,
    },
    actorId
  );

  await auditRepo.record({
    sourceId: created.id,
    action: 'SOURCE_REGISTERED',
    actorId,
    afterState: created,
  });

  await simEvents.emit(simEvents.SIM_EVENT_TYPES.SOURCE_REGISTERED, {
    sourceId: created.id,
    sourceType: created.sourceType,
    displayName: created.displayName,
  });

  logger.info('[SIM.registry] source registered', {
    sourceId: created.id,
    sourceType: created.sourceType,
  });

  return created;
}

// ─────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────

async function getSource(sourceId) {
  const source = await sourceRegistryRepo.findById(sourceId);
  if (!source) throw simErrors.notFound();
  return source;
}

async function searchSources(criteria) {
  return sourceRegistryRepo.search(criteria);
}

async function listActiveEligibleSources() {
  // The one query COM actually needs: sources it is allowed to collect from.
  return sourceRegistryRepo.listByStatus(SOURCE_STATUS.ACTIVE);
}

// ─────────────────────────────────────────────────────────────
// Metadata updates
// ─────────────────────────────────────────────────────────────

async function updateMetadata(sourceId, fields = {}, { actorId = 'system' } = {}) {
  const before = await sourceRegistryRepo.findById(sourceId);
  if (!before) throw simErrors.notFound();

  const patch = sanitizeSourceMetadataPatch(fields);
  if (Object.keys(patch).length === 0) {
    throw simErrors.badRequest('No recognized metadata fields provided.');
  }

  const merged = { ...before, ...patch };
  const recomputedTrust = trustService.blendWithReliability(
    trustService.computeBaseTrustScore(merged),
    before.reliabilityScore
  );

  const after = await sourceRegistryRepo.update(
    sourceId,
    { ...patch, trustScore: recomputedTrust },
    actorId
  );

  await auditRepo.record({
    sourceId,
    action: 'METADATA_UPDATED',
    actorId,
    beforeState: before,
    afterState: after,
  });

  await simEvents.emit(simEvents.SIM_EVENT_TYPES.SOURCE_METADATA_UPDATED, {
    sourceId,
    changedFields: Object.keys(patch),
  });

  return after;
}

async function archiveSource(sourceId, { actorId = 'system', reason } = {}) {
  const after = await governanceService.transitionStatus(sourceId, SOURCE_STATUS.ARCHIVED, {
    actorId,
    reason,
  });

  await simEvents.emit(simEvents.SIM_EVENT_TYPES.SOURCE_ARCHIVED, { sourceId });
  return after;
}

// ─────────────────────────────────────────────────────────────
// Health integration
// ─────────────────────────────────────────────────────────────

const HEALTH_REVIEW_STATUSES = new Set([HEALTH_STATUS.UNHEALTHY]);

async function recordHealthObservation(sourceId, observation, { actorId = 'system' } = {}) {
  const source = await sourceRegistryRepo.findById(sourceId);
  if (!source) throw simErrors.notFound();

  const result = await healthService.recordObservation(sourceId, observation, { actorId });

  await simEvents.emit(simEvents.SIM_EVENT_TYPES.SOURCE_HEALTH_CHANGED, {
    sourceId,
    healthStatus: result.healthStatus,
    reliabilityScore: result.reliabilityScore,
  });

  if (result.statusChanged && HEALTH_REVIEW_STATUSES.has(result.healthStatus)) {
    await governanceService.flagForReviewDueToHealth(sourceId, {
      actorId: 'system:health-monitor',
      reason: `Health degraded to '${result.healthStatus}' after sustained failures.`,
    });
  }

  // Trust score should reflect the freshest reliability read too.
  if (Number.isFinite(result.reliabilityScore)) {
    const blended = trustService.blendWithReliability(source.trustScore, result.reliabilityScore);
    if (blended !== source.trustScore) {
      await sourceRegistryRepo.updateScores(sourceId, { trustScore: blended }, actorId);
      await simEvents.emit(simEvents.SIM_EVENT_TYPES.SOURCE_TRUST_SCORE_UPDATED, {
        sourceId,
        trustScore: blended,
      });
    }
  }

  return result;
}

module.exports = {
  registerSource,
  getSource,
  searchSources,
  listActiveEligibleSources,
  updateMetadata,
  archiveSource,
  recordHealthObservation,
  // re-exported for convenience so controllers don't need three imports
  requestApproval: governanceService.requestApproval,
  decideApproval: governanceService.decideApproval,
  transitionStatus: governanceService.transitionStatus,
  getAuditTrail: governanceService.getAuditTrail,
  getHealthSummary: healthService.getHealthSummary,
  getHealthHistory: healthService.getHistory,
  // Enterprise Enhancement 8 — Source Relationship Model
  addRelationship: relationshipService.addRelationship,
  listRelationships: relationshipService.listRelationships,
  removeRelationship: relationshipService.removeRelationship,
};
