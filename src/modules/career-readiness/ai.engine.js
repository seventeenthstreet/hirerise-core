"use strict";

/**
 * src/modules/career-intelligence/services/ai.engine.js
 *
 * Production-grade AI evaluation engine.
 * - Uses shared AI router-backed anthropic client shim
 * - No direct provider SDK coupling
 * - Deterministic JSON-only output contract
 * - Hardened parsing, validation, logging, and fallback behavior
 */

const logger = require("../../utils/logger");
const aiClient = require("../../config/anthropic.client");

const AI_MODEL = "claude-sonnet-4-6";

const REQUIRED_TOP_LEVEL_FIELDS = [
  "skill_depth_maturity",
  "growth_readiness_index",
  "promotion_probability",
  "career_roadmap",
  "market_risk_assessment",
];

class AIEngine {
  constructor() {
    /**
     * Shared singleton router-backed client
     * Reused across requests for connection efficiency.
     */
    this.client = aiClient;
  }

  buildPrompt(candidateProfile = {}, roleMetadata = {}, deterministicMeta = {}) {
    return {
      system: `You are a professional senior career analyst embedded in an enterprise HR intelligence platform.
Your role is to evaluate a candidate's career readiness based strictly on structured data provided to you.

STRICT RULES:
- Never hallucinate or invent missing data.
- Never assume skills, experience, or achievements not explicitly listed.
- Never make generalizations. Base all inferences on the provided data only.
- Always return valid JSON exactly matching the specified output schema.
- Every assessment must include a confidence score (0.0–1.0) and a reasoning trace.
- If data is insufficient for a dimension, set score to null and state reason in trace.
- Operate at temperature 0. Be precise, structured, and audit-ready.`,

      user: `## CANDIDATE PROFILE
${JSON.stringify(
  {
    skills: candidateProfile.skills ?? [],
    totalYearsExperience: candidateProfile.totalYearsExperience ?? 0,
    workHistory: candidateProfile.workHistory ?? [],
    certifications: candidateProfile.certifications ?? [],
    highestEducation: candidateProfile.highestEducation ?? null,
  },
  null,
  2
)}

## TARGET ROLE
${JSON.stringify(
  {
    title: roleMetadata.title ?? null,
    seniorityLevel: roleMetadata.seniorityLevel ?? null,
    requiredSkills: roleMetadata.requiredSkills ?? [],
    requiredYears: roleMetadata.requiredYears ?? 0,
    leadershipExpected: roleMetadata.leadershipExpected ?? false,
    growthTrajectory: roleMetadata.growthTrajectory ?? null,
  },
  null,
  2
)}

## DETERMINISTIC PRE-COMPUTED DATA (use as grounding context)
${JSON.stringify(
  {
    skillMatchRatio:
      deterministicMeta.skillMatch?.coreMatchRatio ?? null,
    missingCoreSkills:
      deterministicMeta.skillMatch?.missingCoreSkills ?? [],
    experienceDelta:
      deterministicMeta.experienceAlignment?.delta ?? null,
    salaryPositioning:
      deterministicMeta.salaryPositioning?.positioning ?? null,
  },
  null,
  2
)}

## REQUIRED OUTPUT SCHEMA
Return ONLY this JSON object. No prose. No markdown fences.
{
  "skill_depth_maturity": {
    "score": <float 0.0–1.0>,
    "confidence": <float 0.0–1.0>,
    "skill_maturity_map": {
      "<skill_name>": {
        "maturity": "novice|practitioner|advanced|expert",
        "evidence": "<brief>"
      }
    },
    "reasoning_trace": "<string>"
  },
  "growth_readiness_index": {
    "score": <float 0.0–1.0>,
    "confidence": <float 0.0–1.0>,
    "growth_signals": ["<signal>"],
    "risk_factors": ["<risk>"],
    "reasoning_trace": "<string>"
  },
  "promotion_probability": {
    "score": <float 0.0–1.0>,
    "confidence": <float 0.0–1.0>,
    "leadership_signals": ["<signal>"],
    "reasoning_trace": "<string>"
  },
  "career_roadmap": [
    {
      "priority": <int 1–5>,
      "action": "<string>",
      "rationale": "<string>",
      "estimated_impact": "high|medium|low",
      "timeframe": "0-3mo|3-6mo|6-12mo|12mo+"
    }
  ],
  "market_risk_assessment": {
    "risk_level": "low|medium|high",
    "reasoning_trace": "<string>"
  }
}`,
    };
  }

  async evaluate(candidateProfile, roleMetadata, deterministicMeta) {
    const prompt = this.buildPrompt(
      candidateProfile,
      roleMetadata,
      deterministicMeta
    );

    let rawResponse = null;

    try {
      const response = await this.client.messages.create({
        model: AI_MODEL,
        max_tokens: 2000,
        temperature: 0,
        system: prompt.system,
        messages: [{ role: "user", content: prompt.user }],
      });

      rawResponse = this._extractTextResponse(response);

      logger.info("[AIEngine] Raw response received", {
        candidateId: candidateProfile?.candidateId ?? null,
        inputTokens: response?.usage?.input_tokens ?? null,
        outputTokens: response?.usage?.output_tokens ?? null,
      });

      const parsed = JSON.parse(rawResponse);
      this._validateAIResponse(parsed);

      return {
        success: true,
        data: parsed,
        rawResponse,
      };
    } catch (err) {
      logger.error("[AIEngine] Evaluation failed", {
        error: err?.message ?? "Unknown AI error",
        candidateId: candidateProfile?.candidateId ?? null,
        rawResponse,
      });

      return {
        success: false,
        data: this._fallbackResponse(),
        error: err?.message ?? "Unknown AI error",
      };
    }
  }

  _extractTextResponse(response) {
    if (!response?.content || !Array.isArray(response.content)) {
      throw new Error("AI response content missing");
    }

    const textBlock = response.content.find(
      (item) => item?.type === "text" || typeof item?.text === "string"
    );

    if (!textBlock?.text) {
      throw new Error("AI text block missing");
    }

    return textBlock.text.trim();
  }

  _validateAIResponse(data) {
    if (!data || typeof data !== "object") {
      throw new Error("AI response is not an object");
    }

    for (const field of REQUIRED_TOP_LEVEL_FIELDS) {
      if (!(field in data)) {
        throw new Error(`AI response missing required field: ${field}`);
      }
    }

    const score = data?.skill_depth_maturity?.score;

    if (typeof score !== "number" || Number.isNaN(score)) {
      throw new Error("AI score must be numeric");
    }

    if (score < 0 || score > 1) {
      throw new Error("AI score out of bounds");
    }

    if (!Array.isArray(data.career_roadmap)) {
      throw new Error("career_roadmap must be an array");
    }
  }

  _fallbackResponse() {
    return {
      skill_depth_maturity: {
        score: 0.5,
        confidence: 0,
        skill_maturity_map: {},
        reasoning_trace: "AI unavailable — fallback applied",
      },
      growth_readiness_index: {
        score: 0.5,
        confidence: 0,
        growth_signals: [],
        risk_factors: [],
        reasoning_trace: "AI unavailable",
      },
      promotion_probability: {
        score: 0.5,
        confidence: 0,
        leadership_signals: [],
        reasoning_trace: "AI unavailable",
      },
      career_roadmap: [],
      market_risk_assessment: {
        risk_level: "medium",
        reasoning_trace: "AI unavailable",
      },
    };
  }
}

module.exports = AIEngine;