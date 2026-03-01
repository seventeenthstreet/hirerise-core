'use strict';

/**
 * llmClient.js — Stub
 * Replace with real LLM integration (OpenAI, Anthropic, etc.) when ready.
 */

async function generate({ systemPrompt, input, temperature = 0.2 }) {
  // TODO: implement real LLM call
  return {
    growthProjection: {
      projection: {
        "1Year": { probability: 0.65, level: "Mid", salaryRange: { min: 800000, max: 1200000, currency: "INR" } },
        "3Year": { probability: 0.80, level: "Senior", salaryRange: { min: 1200000, max: 1800000, currency: "INR" } },
        "5Year": { probability: 0.90, level: "Lead", salaryRange: { min: 1800000, max: 2500000, currency: "INR" } },
      },
    },
    riskScore: 3,
    recommendations: ["Build system design skills", "Contribute to open source"],
  };
}

module.exports = { generate };