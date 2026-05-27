'use strict';

/**
 * @file src/routes/ai-explanation.routes.js
 *
 * AI Explanation API Route — Phase 4B
 *
 * PURPOSE:
 *   Serves validated AI narrative explanations to the frontend.
 *   All AI output is validated through the Confidence Language Registry
 *   before the response is returned. Invalid output is suppressed and
 *   the deterministic fallback is returned instead.
 *
 * GOVERNANCE CONSTRAINTS:
 *   ✅ IntelligenceSnapshot consumed only — no raw engine calls
 *   ✅ Confidence language validation mandatory before response
 *   ✅ Deterministic fallback returned on all failure modes
 *   ✅ 3-second timeout enforced on AI call
 *   ✅ Telemetry emitted for all outcomes (approved, rejected, fallback)
 *   ✅ No PII in response payload or logs
 *   ✅ Route gated by ai_augmentation_enabled server config
 *
 * ARCHITECTURE POSITION:
 *   API (this file) → Hooks (useAIExplanation) → UI → Pages
 */

const express  = require('express');
const { supabase } = require('../config/supabase');
const logger   = require('../utils/logger');
const {
  createConfidenceLanguageService,
  CONFIDENCE_TIERS,
} = require('../ai/confidence-language');
const { ObservabilityAdapter } = require('../ai/observability/observability-adapter');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const AI_TIMEOUT_MS       = 3000;
const AI_MAX_TOKENS       = 300;
const AI_MODEL            = 'claude-sonnet-4-20250514';
const PROMPT_REGISTRY_ID  = 'explain-recommendations-v1';
const PROMPT_VERSION      = '1.0.0';

// Supported capabilities for this endpoint
const ALLOWED_CAPABILITIES = new Set([
  'explanation_enhancement',
  'recommendation_narrative',
]);

// ─────────────────────────────────────────────────────────────────────────────
// DEPENDENCY SETUP
// ─────────────────────────────────────────────────────────────────────────────

const observabilityAdapter = new ObservabilityAdapter();
const confidenceLanguageService = createConfidenceLanguageService({
  adapter: observabilityAdapter,
});

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function stdError(res, status, code, message) {
  return res.status(status).json({ success: false, errorCode: code, message });
}

/**
 * Loads a sanitised IntelligenceSnapshot for an assessment.
 * AI MUST only consume this — never the raw assessment tables.
 *
 * @param {string} assessmentId
 * @param {string} userId — for row-level security, not logged
 * @returns {Promise<Object|null>}
 */
async function loadIntelligenceSnapshot(assessmentId, userId) {
  // Reads from the governed ai_intelligence_snapshots view (not raw tables)
  const { data, error } = await supabase
    .from('ai_intelligence_snapshots')
    .select([
      'snapshot_version',
      'domain_scores',
      'capability_clusters',
      'confidence',
      'coverage',
      'reliability',
      'explanations',
      'recommendation_metadata',
      // NOTE: raw_score, user_name, email intentionally excluded
    ].join(', '))
    .eq('assessment_id', assessmentId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error || !data) return null;
  return data;
}

/**
 * Calls the AI provider with a timeout.
 * Returns null on timeout or provider error.
 *
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @returns {Promise<string|null>}
 */
async function callAIWithTimeout(systemPrompt, userPrompt) {
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  try {
    const anthropic = require('../config/anthropic.client');
    const response  = await anthropic.messages.create(
      {
        model:      AI_MODEL,
        max_tokens: AI_MAX_TOKENS,
        system:     systemPrompt,
        messages:   [{ role: 'user', content: userPrompt }],
      },
      { signal: controller.signal }
    );

    clearTimeout(timeoutId);
    return response?.content?.[0]?.text ?? null;

  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      logger.warn('[AIExplanation] Timeout — AI call aborted after 3s');
    } else {
      logger.error('[AIExplanation] AI provider error', { message: err.message });
    }
    return null;
  }
}

/**
 * Builds the governed system prompt for explanation enhancement.
 * Injects confidence language grounding instructions from the registry.
 *
 * @param {Object} snapshot
 * @param {string} tier
 * @param {string} capability
 * @returns {string}
 */
function buildGovernedSystemPrompt(snapshot, tier, capability) {
  const languageInstructions = confidenceLanguageService.getPromptInstructions(tier);

  return `You are a career explanation assistant for HireRise.

GOVERNANCE RULES (non-negotiable):
- You are NOT permitted to generate, modify, or imply any numeric score.
- You must present recommendations in the order provided. You may not add, remove, or reorder them.
- Only refer to skills, strengths, and domains that appear in the data provided.
- You may not state confidence levels not present in the data.
- Base every statement on the intelligence snapshot provided. Do not draw on general knowledge to make personalised claims.
- Maximum 150 words.

${languageInstructions}

CAPABILITY: ${capability}

INTELLIGENCE SNAPSHOT:
Confidence: ${tier}
Domain summary: ${JSON.stringify(snapshot.domain_scores?.slice(0, 3) ?? [])}
Explanation: ${snapshot.explanations?.summary ?? 'No summary available.'}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE
// POST /api/ai/explanation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Request body:
 *   { assessmentId: string, capability: string }
 *
 * Response:
 *   { narrative: string, isFallback: boolean, tier: string }
 */
router.post('/', async (req, res) => {
  const { assessmentId, capability } = req.body ?? {};
  const userId = req.user?.id;  // populated by auth middleware upstream

  // ── Input validation ───────────────────────────────────────────────────────
  if (!assessmentId || typeof assessmentId !== 'string') {
    return stdError(res, 400, 'MISSING_ASSESSMENT_ID', 'assessmentId is required');
  }

  if (!capability || !ALLOWED_CAPABILITIES.has(capability)) {
    return stdError(res, 400, 'INVALID_CAPABILITY',
      `capability must be one of: ${[...ALLOWED_CAPABILITIES].join(', ')}`);
  }

  if (!userId) {
    return stdError(res, 401, 'UNAUTHENTICATED', 'Authentication required');
  }

  // ── Load IntelligenceSnapshot ──────────────────────────────────────────────
  const snapshot = await loadIntelligenceSnapshot(assessmentId, userId).catch(() => null);

  if (!snapshot) {
    logger.warn('[AIExplanation] No snapshot found', { assessmentId });
    return res.json({
      narrative:  confidenceLanguageService.getFallbackFor('NO_DATA', capability, 'no_snapshot'),
      isFallback: true,
      tier:       CONFIDENCE_TIERS.NO_DATA,
    });
  }

  // ── Resolve confidence tier from snapshot ──────────────────────────────────
  // Tier is from the deterministic engine — never overridden by AI
  const rawTier = (snapshot.confidence?.tier ?? '').toUpperCase();
  const tier    = CONFIDENCE_TIERS[rawTier] ?? CONFIDENCE_TIERS.NO_DATA;

  // ── Build governed prompt ──────────────────────────────────────────────────
  const systemPrompt = buildGovernedSystemPrompt(snapshot, tier, capability);
  const userPrompt   = 'Provide a brief explanation of this person\'s career profile alignment.';

  // ── Call AI with timeout ───────────────────────────────────────────────────
  const rawNarrative = await callAIWithTimeout(systemPrompt, userPrompt);

  if (!rawNarrative) {
    // AI unavailable or timed out — deterministic fallback
    return res.json({
      narrative:  confidenceLanguageService.getFallbackFor(tier, capability, 'ai_timeout'),
      isFallback: true,
      tier,
    });
  }

  // ── Validate against Confidence Language Registry ─────────────────────────
  const validationResult = confidenceLanguageService.applyToNarrative({
    narrative:    rawNarrative,
    tier,
    capability,
    promptId:     PROMPT_REGISTRY_ID,
    promptVersion: PROMPT_VERSION,
  });

  // validationResult.narrative is always safe to return:
  //   approved=true  → validated AI narrative
  //   approved=false → deterministic fallback copy
  return res.json({
    narrative:  validationResult.narrative,
    isFallback: validationResult.isFallback,
    tier,
  });
});

module.exports = router;
