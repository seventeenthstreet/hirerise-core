'use strict';

/**
 * core/src/modules/admin/intelligence/adminSignalLineage.controller.js
 *
 * Admin Signal Lineage Controller
 * A09 — Phase 2A.1.3
 *
 * Endpoint:
 *   GET /api/v1/intelligence/admin/signal-lineage/:signal_key
 *
 * Data Source:
 *   fn_get_signal_lineage_summary(p_signal_key)
 *   SECURITY DEFINER RPC
 *
 * Security:
 *   authenticate + requireAdmin
 *   (enforced at route mount level)
 *
 * Notes:
 * - Read-only governance endpoint.
 * - Empty lineage result is a valid success response.
 * - proposedBy null must be preserved.
 * - updatedAt must never be fabricated.
 * - No pagination required for current lineage volumes.
 */

const { asyncHandler } = require('../../../utils/helpers');
const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');
const { supabase } = require('../../../config/supabase');
const logger = require('../../../utils/logger');

/**
 * Maps a raw lineage summary RPC row into the approved API DTO.
 *
 * Null values are intentionally preserved.
 *
 * @param {Object} raw
 * @returns {Object}
 */
function mapRpcRowToLineageSummaryRecord(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid lineage row');
  }

  return {
    id: raw.lineage_id,

    predecessorSignalKey:
      raw.predecessor_signal_key,

    successorSignalKey:
      raw.successor_signal_key ?? null,

    lineageType:
      raw.lineage_type,

    lineageReason:
      raw.lineage_reason,

    effectiveDate:
      raw.effective_date,

    taxonomyVersion:
      raw.taxonomy_version,

    proposedBy:
      raw.proposed_by ?? null,

    proposedAt:
      raw.proposed_at,

    approvedBy:
      raw.approved_by ?? null,

    approvedAt:
      raw.approved_at ?? null,

    weightReviewRequired:
      raw.weight_review_required,

    weightReviewCompletedAt:
      raw.weight_review_completed_at ?? null,

    triggeredByPipelineRunId:
      raw.triggered_by_pipeline_run_id ?? null,
  };
}

/**
 * GET /api/v1/intelligence/admin/signal-lineage/:signal_key
 *
 * Returns lineage summary records for a signal key.
 *
 * Response:
 * {
 *   success: true,
 *   data: {
 *     signalKey,
 *     lineage,
 *     total
 *   },
 *   meta: {
 *     duration_ms
 *   }
 * }
 */
const getSignalLineage = asyncHandler(async (req, res) => {
  const start = Date.now();

  const signalKey = (req.params.signal_key || '').trim();

  // Defence-in-depth validation.
  // Route validator should catch this first.
  if (!signalKey) {
    throw new AppError(
      'signal_key is required',
      ErrorCodes.VALIDATION_ERROR,
      400,
      {}
    );
  }

  const adminId = req.user?.uid;

  logger.info('[AdminSignalLineage] query received', {
    signalKey,
    adminId,
  });

  // Execute approved Sprint 1C lineage RPC
  const { data, error } = await supabase.rpc(
    'fn_get_signal_lineage_summary',
    {
      p_signal_key: signalKey,
    }
  );

  if (error) {
    const duration_ms = Date.now() - start;

    logger.error('[AdminSignalLineage] RPC failed', {
      signalKey,
      error: error.message,
      duration_ms,
    });

    throw new AppError(
      'Failed to retrieve signal lineage',
      ErrorCodes.INTERNAL_ERROR,
      500,
      {}
    );
  }

  // RPC may return null when no rows exist.
  const rawRows = Array.isArray(data)
    ? data
    : [];

  const lineage = [];

  for (const raw of rawRows) {
    try {
      lineage.push(
        mapRpcRowToLineageSummaryRecord(raw)
      );
    } catch (mappingErr) {
      logger.warn(
        '[AdminSignalLineage] row mapping warning — skipping malformed row',
        {
          signalKey,
          rowId:
            raw?.lineage_id ??
            '(unknown)',
          reason:
            mappingErr.message,
        }
      );
    }
  }

  const duration_ms = Date.now() - start;

  logger.info('[AdminSignalLineage] query complete', {
    signalKey,
    count: lineage.length,
    duration_ms,
  });

  return res.json({
    success: true,
    data: {
      signalKey,
      lineage,
      total: lineage.length,
    },
    meta: {
      duration_ms,
    },
  });
});

module.exports = {
  getSignalLineage,
};