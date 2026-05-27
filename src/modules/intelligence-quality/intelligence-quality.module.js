'use strict';

/**
 * src/modules/intelligence-quality/intelligence-quality.module.js
 *
 * Module bootstrap for the Phase 4A Intelligence Quality system.
 *
 * Wires together:
 *   - IntelligenceQualityService
 *   - Four repositories (coverage, reliability, stability, drift)
 *   - Supabase client (injected)
 *   - Analytics adapter (injected)
 *   - Logger (injected)
 *
 * Pattern: lazy singleton — service is created once on first call.
 * This avoids circular import issues and keeps startup fast.
 *
 * Usage:
 *   const { getQualityService } = require('./intelligence-quality.module');
 *   const service = getQualityService();
 *   await service.getQualityReport(userId);
 */

const { supabase }         = require('../../config/supabase');
const logger               = require('../../utils/logger');
const IntelligenceQualityService  = require('../../intelligence/intelligence-quality.service');
const {
  SignalCoverageRepository,
  SignalReliabilityRepository,
  ClusterStabilityRepository,
  ClusterDriftRepository,
} = require('../../intelligence/intelligence-quality.repositories');

// ─────────────────────────────────────────────────────────────
// ANALYTICS ADAPTER
// Wraps the existing analytics infrastructure.
// Swappable without touching service code.
// ─────────────────────────────────────────────────────────────

async function analyticsAdapter(event) {
  try {
    // Insert into the existing analytics pipeline.
    // Replace with your actual analytics sink (Segment, PostHog, internal table, etc.)
    await supabase
      .from('analytics_events')
      .insert({
        event_type:  event.eventType,
        dedupe_key:  event.dedupeKey,
        occurred_at: event.occurredAt,
        payload:     event.payload,
      })
      .throwOnError();
  } catch (err) {
    // Analytics failures must never throw — quality service catches these too,
    // but a double-guard here keeps the adapter self-contained.
    logger.warn('[intelligence-quality.analytics] Failed to persist event', {
      eventType: event.eventType,
      error:     err?.message,
    });
  }
}

// ─────────────────────────────────────────────────────────────
// SINGLETON
// ─────────────────────────────────────────────────────────────

/** @type {IntelligenceQualityService | null} */
let _serviceInstance = null;

/**
 * Returns the singleton IntelligenceQualityService instance.
 * Created once; reused on subsequent calls.
 */
function getQualityService() {
  if (_serviceInstance) return _serviceInstance;

  _serviceInstance = new IntelligenceQualityService({
    coverageRepository:    new SignalCoverageRepository(supabase),
    reliabilityRepository: new SignalReliabilityRepository(supabase),
    stabilityRepository:   new ClusterStabilityRepository(supabase),
    driftRepository:       new ClusterDriftRepository(supabase),
    analyticsAdapter,
    logger,
    config: {}, // inject config overrides here if needed
  });

  return _serviceInstance;
}

/**
 * Replaces the singleton — for testing only.
 * @param {IntelligenceQualityService} mockService
 */
function _setQualityServiceForTesting(mockService) {
  _serviceInstance = mockService;
}

module.exports = { getQualityService, _setQualityServiceForTesting };
