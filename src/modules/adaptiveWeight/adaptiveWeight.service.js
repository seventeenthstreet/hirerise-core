'use strict';

/**
 * adaptiveWeight.service.js
 *
 * WP-ADMIN-COMP-AW-03 — Backend Contract Reconciliation Implementation
 *
 * Reconciled to the canonical RPC-based repository contract:
 *   getWeights() / recordOutcome() / applyOverride() / releaseOverride()
 *
 * The certified database functions (get_adaptive_weights(),
 * record_adaptive_outcome()) and the new AW-03 functions
 * (apply_adaptive_override(), release_adaptive_override()) are
 * authoritative for all adaptive-learning business logic — fetch/create,
 * clamping, normalization, performance smoothing, confidence adjustment,
 * override/freeze state, and persistence. This service performs
 * validation, delegates to the repository, and maps the canonical RPC
 * response onto the existing external (controller-facing) contract. It
 * does not reproduce RPC business logic in JavaScript.
 */

const {
  DEFAULT_WEIGHTS,
} = require('./adaptiveWeight.constants');

const {
  validateWeightKey,
  validateOutcomePayload,
  validateManualOverride,
} = require('./adaptiveWeight.validator');

const logger = require('../../utils/logger');
const { logAdminAction } = require('../../utils/adminAuditLogger');

class AdaptiveWeightService {
  constructor({ adaptiveWeightRepo }) {
    this._repo = adaptiveWeightRepo;
  }

  // ═══════════════════════════════════════════════════════════
  // 🎯 GET WEIGHTS (Controller-compatible)
  // ═══════════════════════════════════════════════════════════

  async getWeightsForScoring({
    roleFamily,
    experienceBucket,
    industryTag,
    requestId,
  }) {
    try {
      const validated = validateWeightKey({ roleFamily, experienceBucket, industryTag });

      const data = await this._repo.getWeights({
        roleFamily: validated.roleFamily,
        experienceBucket: validated.experienceBucket,
        industryTag: validated.industryTag,
        requestId,
      });

      // get_adaptive_weights() is authoritative for weights, source,
      // metadata, manual-override state, and default/no-record behavior.
      // The service maps the RPC's response directly onto the existing
      // external contract rather than recomputing any of it here.
      return {
        weights: data.weights,
        source: data.source,
        meta: data.meta,
      };

    } catch (err) {
      if (err.name === 'AdaptiveWeightValidationError') throw err;

      logger.error('[AdaptiveWeightService:getWeightsForScoring]', {
        requestId,
        error: err.message,
      });

      return this._defaultResponse('service_error');
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 📥 RECORD OUTCOME + LEARNING
  // ═══════════════════════════════════════════════════════════

  async recordOutcome(payload) {
    const { requestId } = payload;

    const validated = validateOutcomePayload(payload);

    const data = await this._repo.recordOutcome({
      roleFamily: validated.roleFamily,
      experienceBucket: validated.experienceBucket,
      industryTag: validated.industryTag,
      predictedScore: validated.predictedScore,
      actualOutcome: validated.actualOutcome,
      requestId,
    });

    // record_adaptive_outcome() is authoritative for fetch/create,
    // learning delta, clamping, normalization, performance smoothing,
    // confidence adjustment, persistence, and freeze-learning behavior.
    //
    // NOTE (frozen-segment field gap — see AW-03 implementation report,
    // "Remaining Follow-Up"): when the segment is frozen, the certified
    // RPC intentionally returns only `{ updated: false }`
    // (record_adaptive_outcome(), 000_initial_schema.sql) — no weights,
    // performanceScore, or confidenceScore. AW-03 requires a single
    // recordOutcome() call and forbids altering the certified RPC, so
    // those three fields are not recoverable in the frozen branch without
    // either a second RPC call (which would violate the "single call"
    // requirement in §6) or changing the certified function (out of
    // scope, §18). They are mapped through as `null` rather than
    // fabricated from stale local state.
    return {
      updated: data.updated === true,
      newWeights: data.weights ?? null,
      performanceScore: data.performanceScore ?? null,
      confidenceScore: data.confidenceScore ?? null,
    };
  }

  // ═══════════════════════════════════════════════════════════
  // 🛠️ MANUAL OVERRIDE
  // ═══════════════════════════════════════════════════════════

  async applyManualOverride(payload) {
    const { requestId, adminId, ipAddress } = payload;

    const validated = validateManualOverride(payload);

    const data = await this._repo.applyOverride({
      roleFamily: validated.roleFamily,
      experienceBucket: validated.experienceBucket,
      industryTag: validated.industryTag,
      weights: validated.weights,
      requestId,
    });

    // Audit only after successful persistence. Fire-and-forget:
    // logAdminAction() never throws (adminAuditLogger.js), so a logging
    // failure can never turn this already-successful mutation into an
    // HTTP failure. Follows the adminUsers.service.js pattern; the
    // trailing .catch() is defense in depth only (mirrors
    // permissionAssignment.controller.js's emitPermissionAudit()).
    logAdminAction({
      adminId,
      action: 'ADAPTIVE_WEIGHT_OVERRIDE_APPLY',
      entityType: 'adaptive_weight',
      entityId: `${validated.roleFamily}::${validated.experienceBucket}::${validated.industryTag}`,
      metadata: { weights: data.weights },
      ipAddress,
    }).catch(() => {});

    return {
      weights: data.weights,
      manualOverride: true,
    };
  }

  async releaseManualOverride(payload) {
    const { requestId, adminId, ipAddress } = payload;

    const validated = validateWeightKey(payload);

    const data = await this._repo.releaseOverride({
      roleFamily: validated.roleFamily,
      experienceBucket: validated.experienceBucket,
      industryTag: validated.industryTag,
      requestId,
    });

    // Audit only after a persistence change actually occurred. release_adaptive_override()
    // returns { released: false } as a safe no-op when no segment exists to release
    // (AW-03 migration comment, consistent with get_adaptive_weights()'s no-record
    // handling) — that branch updates no row, so logging
    // ADAPTIVE_WEIGHT_OVERRIDE_RELEASE for it would record an admin action that never
    // happened in the audit trail. Gating on data.released === true keeps the
    // fire-and-forget pattern (trailing .catch() is defense in depth only) for the
    // one case that actually mutated state, matching applyManualOverride()'s
    // audit-only-after-successful-persistence rule (§ AW-03).
    if (data?.released === true) {
      logAdminAction({
        adminId,
        action: 'ADAPTIVE_WEIGHT_OVERRIDE_RELEASE',
        entityType: 'adaptive_weight',
        entityId: `${validated.roleFamily}::${validated.experienceBucket}::${validated.industryTag}`,
        ipAddress,
      }).catch(() => {});
    }

    return { released: data?.released === true };
  }

  // ═══════════════════════════════════════════════════════════
  // 🔧 HELPERS
  // ═══════════════════════════════════════════════════════════

  _defaultResponse(reason) {
    return {
      weights: { ...DEFAULT_WEIGHTS },
      source: 'default',
      meta: { reason },
    };
  }
}

module.exports = AdaptiveWeightService;
