'use strict';

/**
 * src/modules/source-intelligence/services/sourceGovernance.service.js
 *
 * Governance Model (deliverable #8): status lifecycle, approval workflow,
 * ownership tracking, and the audit trail that backs all of it.
 *
 * All state transitions for a source's `status` field MUST go through
 * this service — repositories never validate business rules, and
 * source.controller.js never writes status directly.
 */

const sourceRegistryRepo = require('../repositories/sourceRegistry.repository');
const auditRepo = require('../repositories/sourceAudit.repository');
const {
  SOURCE_STATUS,
  APPROVAL_STATUS,
  canTransitionStatus,
} = require('../models/source.model');
const simErrors = require('../errors/sim.errors');
const simEvents = require('../events/sim.events');
const logger = require('../../../utils/logger');

async function requestApproval(sourceId, { actorId = 'system', reason = null } = {}) {
  const source = await sourceRegistryRepo.findById(sourceId);
  if (!source) throw simErrors.notFound();

  return transitionStatus(sourceId, SOURCE_STATUS.PENDING_APPROVAL, {
    actorId,
    reason: reason || 'Submitted for governance approval',
    approvalStatus: APPROVAL_STATUS.PENDING,
  });
}

async function decideApproval(sourceId, { approved, actorId = 'system', reason = null } = {}) {
  const source = await sourceRegistryRepo.findById(sourceId);
  if (!source) throw simErrors.notFound();

  if (source.status !== SOURCE_STATUS.PENDING_APPROVAL) {
    throw simErrors.governanceViolation(
      'Source is not currently pending approval.',
      { currentStatus: source.status }
    );
  }

  const nextStatus = approved ? SOURCE_STATUS.ACTIVE : SOURCE_STATUS.REVIEW_REQUIRED;
  const approvalStatus = approved ? APPROVAL_STATUS.APPROVED : APPROVAL_STATUS.REJECTED;

  const updated = await transitionStatus(sourceId, nextStatus, {
    actorId,
    reason,
    approvalStatus,
    approvedBy: actorId,
    approvedAt: new Date().toISOString(),
  });

  return updated;
}

/**
 * Central, audited status transition. Validates the transition against
 * the lifecycle graph in source.model.js, writes the audit trail, updates
 * the registry row, and emits the SIM.SOURCE_STATUS_CHANGED event (and,
 * where relevant, the eligibility events COM cares about).
 */
async function transitionStatus(sourceId, toStatus, {
  actorId = 'system',
  reason = null,
  approvalStatus,
  approvedBy,
  approvedAt,
} = {}) {
  const before = await sourceRegistryRepo.findById(sourceId);
  if (!before) throw simErrors.notFound();

  if (!canTransitionStatus(before.status, toStatus)) {
    throw simErrors.invalidTransition(before.status, toStatus);
  }

  const patch = { status: toStatus };
  if (approvalStatus !== undefined) patch.approvalStatus = approvalStatus;
  if (approvedBy !== undefined) patch.approvedBy = approvedBy;
  if (approvedAt !== undefined) patch.approvedAt = approvedAt;

  const after = await sourceRegistryRepo.update(sourceId, patch, actorId);

  await auditRepo.record({
    sourceId,
    action: 'STATUS_TRANSITION',
    actorId,
    reason,
    beforeState: { status: before.status, approvalStatus: before.approvalStatus },
    afterState: { status: after.status, approvalStatus: after.approvalStatus },
  });

  await simEvents.emit(simEvents.SIM_EVENT_TYPES.SOURCE_STATUS_CHANGED, {
    sourceId,
    fromStatus: before.status,
    toStatus: after.status,
    actorId,
    reason,
  });

  const wasEligible = simEvents.isEligibleForCollection(before);
  const isEligible = simEvents.isEligibleForCollection(after);

  if (!wasEligible && isEligible) {
    await simEvents.emit(simEvents.SIM_EVENT_TYPES.SOURCE_ELIGIBLE_FOR_COLLECTION, {
      sourceId,
    });
  } else if (wasEligible && !isEligible) {
    await simEvents.emit(simEvents.SIM_EVENT_TYPES.SOURCE_INELIGIBLE_FOR_COLLECTION, {
      sourceId,
      reason: `status changed to ${after.status}`,
    });
  }

  logger.info('[SIM.governance] status transition', {
    sourceId,
    from: before.status,
    to: after.status,
    actorId,
  });

  return after;
}

/**
 * Auto-governance hook: sourceHealth.service reports sustained failures via
 * this entry point rather than writing status itself, keeping "health
 * observation" and "governance decision" as separate, auditable concerns.
 */
async function flagForReviewDueToHealth(sourceId, { reason, actorId = 'system' } = {}) {
  const source = await sourceRegistryRepo.findById(sourceId);
  if (!source) throw simErrors.notFound();

  if (source.status !== SOURCE_STATUS.ACTIVE) {
    return source; // only auto-flag sources that are currently in service
  }

  if (!canTransitionStatus(source.status, SOURCE_STATUS.REVIEW_REQUIRED)) {
    return source;
  }

  return transitionStatus(sourceId, SOURCE_STATUS.REVIEW_REQUIRED, {
    actorId,
    reason: reason || 'Automatically flagged: sustained health degradation',
  });
}

async function getAuditTrail(sourceId, options) {
  return auditRepo.listForSource(sourceId, options);
}

module.exports = {
  requestApproval,
  decideApproval,
  transitionStatus,
  flagForReviewDueToHealth,
  getAuditTrail,
};
