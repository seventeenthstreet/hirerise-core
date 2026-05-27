'use strict';

/**
 * @file src/ai/confidence-language/ai-confidence-language.registry.js
 *
 * AI Confidence Language Registry — Phase 4B Governance Layer
 *
 * PURPOSE:
 *   Standardises AI-generated language according to deterministic confidence
 *   tiers. Prevents confidence inflation, overclaiming, psychologically
 *   misleading wording, and semantic inconsistency across all AI augmentation
 *   capabilities.
 *
 * GOVERNANCE CONSTRAINTS:
 *   ✅ Deterministic mappings only — no dynamic AI-generated vocabulary
 *   ✅ Immutable registry structure (Object.freeze throughout)
 *   ✅ Versioned for auditability and rollback
 *   ✅ Localisation-safe schema (all strings are keys, not inline copy)
 *   ✅ Registry does NOT calculate, modify, infer, or override confidence
 *   ✅ Registry is a governance layer only — it validates, never generates
 *
 * CONFIDENCE TIERS align with classifyConfidence() in confidence.model.js:
 *   HIGH   → score >= 80
 *   MEDIUM → score >= 60
 *   LOW    → score < 60
 *   NO_DATA → no score available
 *
 * ARCHITECTURE POSITION:
 *   deterministic engine → IntelligenceSnapshot → [this registry] → AI output validation → UI
 */

// ─────────────────────────────────────────────────────────────────────────────
// REGISTRY VERSION
// Bump on any vocabulary change. Used in telemetry and audit logs.
// ─────────────────────────────────────────────────────────────────────────────

const REGISTRY_VERSION = Object.freeze({
  version:   '1.0.0',
  createdAt: '2026-05-17',
  owner:     'hirerise-ai-governance',
});

// ─────────────────────────────────────────────────────────────────────────────
// CONFIDENCE TIER IDENTIFIERS
// Must match classifyConfidence() output in confidence.model.js exactly.
// ─────────────────────────────────────────────────────────────────────────────

const CONFIDENCE_TIERS = Object.freeze({
  HIGH:    'HIGH',
  MEDIUM:  'MEDIUM',
  LOW:     'LOW',
  NO_DATA: 'NO_DATA',
});

// ─────────────────────────────────────────────────────────────────────────────
// VOCABULARY REGISTRY
//
// Each tier defines:
//   allowed   — phrases that MAY appear in AI output for this tier
//   preferred — the recommended subset (used in fallback copy and prompts)
//   prohibited — phrases that MUST NOT appear in AI output for this tier
//   fallback  — the deterministic copy to render when AI output is suppressed
//
// Rules:
//   - preferred is always a strict subset of allowed
//   - A phrase in prohibited for one tier may be allowed in another
//   - Match is substring-based, case-insensitive (see validator)
// ─────────────────────────────────────────────────────────────────────────────

const VOCABULARY = Object.freeze({

  [CONFIDENCE_TIERS.HIGH]: Object.freeze({
    allowed: Object.freeze([
      'strong alignment',
      'consistently demonstrated',
      'well-supported',
      'clearly indicates',
      'robust signal',
      'well-established',
      'highly relevant',
      'strong match',
      'strong evidence',
      'your profile shows',
      'confidently suggests',
      'solid foundation',
      'strong profile',
      'demonstrates clearly',
      'well-evidenced',
    ]),

    preferred: Object.freeze([
      'strong alignment',
      'consistently demonstrated',
      'well-supported',
      'your profile shows strong',
      'confidently suggests',
    ]),

    prohibited: Object.freeze([
      'guaranteed',
      'perfect fit',
      'certain success',
      'will definitely',
      'absolute',
      'always succeed',
      'no risk',
      'flawless',
      'unquestionably',
      'without doubt',
      'certain match',
      'perfect match',
      '100%',
      // Also prohibit low-confidence hedging — would undermine a HIGH signal
      'limited signal',
      'early indication',
      'not enough data',
      'unclear whether',
      'hard to say',
      'possibly indicates',
      'might suggest',
    ]),

    fallback: 'Your profile shows strong alignment with this direction.',
  }),

  [CONFIDENCE_TIERS.MEDIUM]: Object.freeze({
    allowed: Object.freeze([
      'suggests',
      'indicates',
      'shows some alignment',
      'shows alignment',
      'some evidence',
      'emerging signals',
      'developing strengths',
      'profile suggests',
      'your background suggests',
      'early strengths',
      'shows potential',
      'positive signals',
      'relevant experience',
      'appears well-suited',
      'may be a good fit',
      'encouraging signals',
    ]),

    preferred: Object.freeze([
      'your profile suggests',
      'indicates some alignment',
      'shows alignment',
      'encouraging signals',
      'emerging strengths',
    ]),

    prohibited: Object.freeze([
      // Upward escalation — prohibited from MEDIUM
      'strong alignment',
      'consistently demonstrated',
      'guaranteed',
      'perfect fit',
      'certain success',
      'will definitely',
      'absolute',
      'highly confident',
      'robust signal',
      'clearly demonstrates',
      'unquestionably',
      // Downward — NO_DATA language also prohibited
      'not enough data',
      'no signal',
      'we cannot assess',
    ]),

    fallback: 'Your profile suggests some alignment with this direction.',
  }),

  [CONFIDENCE_TIERS.LOW]: Object.freeze({
    allowed: Object.freeze([
      'early indication',
      'limited signal',
      'exploratory direction',
      'early signals suggest',
      'based on limited data',
      'preliminary signals',
      'some early indication',
      'initial signals',
      'early-stage signals',
      'tentative indication',
      'worth exploring',
      'may be worth considering',
      'emerging interest',
    ]),

    preferred: Object.freeze([
      'early indication',
      'limited signal',
      'based on limited data',
      'exploratory direction',
      'early signals suggest',
    ]),

    prohibited: Object.freeze([
      // All high/medium escalation language is prohibited at LOW
      'strong alignment',
      'ideal fit',
      'highly suited',
      'consistently demonstrated',
      'well-supported',
      'confidently suggests',
      'robust signal',
      'clearly indicates',
      'guaranteed',
      'perfect fit',
      'certain success',
      'strong match',
      'strong evidence',
      'strong profile',
      // Also prohibit NO_DATA language — LOW has some signal
      'no data',
      'we have no information',
      'cannot assess at all',
    ]),

    fallback: 'Based on limited data, there are early signals worth exploring in this direction.',
  }),

  [CONFIDENCE_TIERS.NO_DATA]: Object.freeze({
    allowed: Object.freeze([
      "we don't yet have enough information",
      'not enough information yet',
      'more data needed',
      'no assessment available',
      'your profile is still building',
      'once we have more information',
      'as your profile develops',
      'currently insufficient data',
      'not yet assessed',
      'pending more signal',
    ]),

    preferred: Object.freeze([
      "we don't yet have enough information",
      'your profile is still building',
      'not enough information yet',
    ]),

    prohibited: Object.freeze([
      // Any capability claim is prohibited with no data
      'strong alignment',
      'shows alignment',
      'suggests',
      'indicates',
      'early indication',
      'limited signal',
      'demonstrates',
      'evidenced',
      'you are suited',
      'you would excel',
      'you are a good fit',
      'your skills match',
      // Fabricated negative assessments equally prohibited
      'you are not suited',
      'you lack',
      'you are unlikely to succeed',
      'poor fit',
    ]),

    fallback: "We don't yet have enough information to assess this direction. Your profile will strengthen as more data is collected.",
  }),

});

// ─────────────────────────────────────────────────────────────────────────────
// PROMPT GROUNDING INSTRUCTIONS
// Injected into system prompts to enforce vocabulary governance at generation.
// These are pulled from the registry — not hardcoded in prompt builders.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the vocabulary instruction block to inject into a system prompt
 * for a given confidence tier. Prompt builders MUST call this — never
 * hardcode tier-specific language in prompt files.
 *
 * @param {string} tier — one of CONFIDENCE_TIERS
 * @returns {string} instruction block safe for system prompt injection
 */
function getPromptGroundingInstructions(tier) {
  const vocab = VOCABULARY[tier];

  if (!vocab) {
    throw new Error(
      `[ConfidenceLanguageRegistry] Unknown tier "${tier}". ` +
      `Valid tiers: ${Object.values(CONFIDENCE_TIERS).join(', ')}`
    );
  }

  const preferredList  = vocab.preferred.join(', ');
  const prohibitedList = vocab.prohibited.join(', ');

  return (
    `CONFIDENCE TIER: ${tier}\n` +
    `You are describing a profile with ${tier} confidence.\n` +
    `PREFERRED language (use these): ${preferredList}.\n` +
    `PROHIBITED language (never use): ${prohibitedList}.\n` +
    `If confidence does not support a claim, use the fallback: "${vocab.fallback}"`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

module.exports = Object.freeze({
  REGISTRY_VERSION,
  CONFIDENCE_TIERS,
  VOCABULARY,
  getPromptGroundingInstructions,
});
