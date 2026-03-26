// ai.engine.js
//
// REFACTORED: Uses the shared anthropic.client shim (AI Router) instead of
// instantiating the Anthropic SDK directly. All provider fallback logic is
// handled transparently by the router — no other changes needed in this file.
//
const logger = require("../../utils/logger");

const AI_MODEL = "claude-sonnet-4-6"; // kept for reference; router selects actual provider

class AIEngine {
  constructor() {
    // The shared client is a router-backed proxy with the same messages.create() API.
    this.client = require("../../config/anthropic.client");
  }

  buildPrompt(candidateProfile, roleMetadata, deterministicMeta) {
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
${JSON.stringify({
  skills: candidateProfile.skills,
  totalYearsExperience: candidateProfile.totalYearsExperience,
  workHistory: candidateProfile.workHistory,
  certifications: candidateProfile.certifications,
  highestEducation: candidateProfile.highestEducation,
}, null, 2)}

## TARGET ROLE
${JSON.stringify({
  title: roleMetadata.title,
  seniorityLevel: roleMetadata.seniorityLevel,
  requiredSkills: roleMetadata.requiredSkills,
  requiredYears: roleMetadata.requiredYears,
  leadershipExpected: roleMetadata.leadershipExpected,
  growthTrajectory: roleMetadata.growthTrajectory,
}, null, 2)}

## DETERMINISTIC PRE-COMPUTED DATA (use as grounding context)
${JSON.stringify({
  skillMatchRatio: deterministicMeta.skillMatch.coreMatchRatio,
  missingCoreSkills: deterministicMeta.skillMatch.missingCoreSkills,
  experienceDelta: deterministicMeta.experienceAlignment.delta,
  salaryPositioning: deterministicMeta.salaryPositioning.positioning,
}, null, 2)}

## REQUIRED OUTPUT SCHEMA
Return ONLY this JSON object. No prose. No markdown fences.
{
  "skill_depth_maturity": {
    "score": <float 0.0–1.0>,
    "confidence": <float 0.0–1.0>,
    "skill_maturity_map": {
      "<skill_name>": { "maturity": "novice|practitioner|advanced|expert", "evidence": "<brief>" }
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
    const prompt = this.buildPrompt(candidateProfile, roleMetadata, deterministicMeta);

    let rawResponse;
    try {
      const response = await this.client.messages.create({
        model: AI_MODEL,
        max_tokens: 2000,
        temperature: 0,
        system: prompt.system,
        messages: [{ role: "user", content: prompt.user }],
      });

      rawResponse = response.content[0].text;
      logger.info("[AIEngine] Raw response received", {
        candidateId: candidateProfile.candidateId,
        inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens,
      });

      const parsed = JSON.parse(rawResponse);
      this._validateAIResponse(parsed);
      return { success: true, data: parsed, rawResponse };

    } catch (err) {
      logger.error("[AIEngine] Evaluation failed", {
        error: err.message,
        candidateId: candidateProfile.candidateId,
        rawResponse: rawResponse || null,
      });

      // Graceful degradation — return conservative fallback
      return {
        success: false,
        data: this._fallbackResponse(),
        error: err.message,
      };
    }
  }

  _validateAIResponse(data) {
    const required = ["skill_depth_maturity", "growth_readiness_index", "promotion_probability", "career_roadmap"];
    for (const key of required) {
      if (!data[key]) throw new Error(`AI response missing required field: ${key}`);
    }
    if (typeof data.skill_depth_maturity.score !== "number") throw new Error("AI score not numeric");
    if (data.skill_depth_maturity.score < 0 || data.skill_depth_maturity.score > 1) throw new Error("AI score out of bounds");
  }

  _fallbackResponse() {
    return {
      skill_depth_maturity: { score: 0.5, confidence: 0, skill_maturity_map: {}, reasoning_trace: "AI unavailable — fallback applied" },
      growth_readiness_index: { score: 0.5, confidence: 0, growth_signals: [], risk_factors: [], reasoning_trace: "AI unavailable" },
      promotion_probability: { score: 0.5, confidence: 0, leadership_signals: [], reasoning_trace: "AI unavailable" },
      career_roadmap: [],
      market_risk_assessment: { risk_level: "medium", reasoning_trace: "AI unavailable" },
    };
  }
}

module.exports = AIEngine;








