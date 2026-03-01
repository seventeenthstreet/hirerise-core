'use strict';

/**
 * resume.service.js — EXAMPLE integration of AI Observability
 *
 * This shows how an EXISTING service integrates the observability layer.
 * NO changes to existing business logic are required — just wrap the AI call
 * with withObservability().
 *
 * Key points:
 *  - Input is hashed BEFORE being passed to the AI — raw text never stored
 *  - withObservability handles all logging, cost, drift, and alerts
 *  - Service logic is unchanged; observability is purely additive
 */

const { withObservability } = require('../middleware/ai-observability.middleware');
const AILogger = require('../ai/observability/logger');

// --- Assume these are your existing dependencies ---
// const resumeRepository = require('../repositories/resume.repository');
// const openai = require('../config/openai.client');

class ResumeService {
  /**
   * Score a resume using AI.
   * Before observability, this was a plain async function.
   * After: wrap the AI call in withObservability(). Zero changes to business logic.
   */
  async scoreResume(userId, resumeText, options = {}) {
    // Hash the raw input BEFORE any processing — never store raw PII
    const inputHash = AILogger.hashInput(resumeText);

    const model = options.model || process.env.RESUME_SCORING_MODEL || 'gpt-4o';
    const modelVersion = options.modelVersion || '2024-11-20';

    // Wrap AI call with full observability instrumentation
    const result = await withObservability(
      {
        feature: 'resume_scoring',
        userId,
        model,
        modelVersion,
        inputHash,
      },
      async () => {
        // === YOUR EXISTING AI CALL UNCHANGED ===
        // const completion = await openai.chat.completions.create({
        //   model,
        //   messages: [
        //     { role: 'system', content: RESUME_SCORING_SYSTEM_PROMPT },
        //     { role: 'user', content: resumeText },
        //   ],
        //   temperature: 0.2,
        // });

        // MOCK for illustration:
        const completion = {
          choices: [{ message: { content: '{"score":82,"tier":"strong","topSkills":["React","Node.js","AWS"]}' } }],
          usage: { prompt_tokens: 1200, completion_tokens: 450 },
        };

        const parsed = JSON.parse(completion.choices[0].message.content);

        // Return shape expected by withObservability
        return {
          result: parsed,                          // your actual business output
          tokensInput: completion.usage.prompt_tokens,
          tokensOutput: completion.usage.completion_tokens,
          confidenceScore: 0.87,                  // from your model or calibration logic
          outputSummary: {                         // SAFE fields only — no PII
            score: parsed.score,
            tier: parsed.tier,
            topSkills: parsed.topSkills,
          },
        };
      }
    );

    // result.result is your business output
    // result._observability.costUSD is available if needed
    return result.result;
  }

  /**
   * Example: salary benchmark with observability
   */
  async getSalaryBenchmark(userId, jobTitle, location, yearsExp) {
    const inputHash = AILogger.hashInput(`${jobTitle}:${location}:${yearsExp}`);
    const model = process.env.SALARY_MODEL || 'gpt-4o-mini';

    const result = await withObservability(
      { feature: 'salary_benchmark', userId, model, inputHash },
      async () => {
        // === YOUR EXISTING SALARY AI CALL ===
        // Mock:
        const salaryData = { min: 90000, max: 130000, median: 110000, currency: 'USD' };
        const tokensUsed = { input: 800, output: 200 };

        return {
          result: salaryData,
          tokensInput: tokensUsed.input,
          tokensOutput: tokensUsed.output,
          confidenceScore: 0.91,
          outputSummary: {
            salaryMin: salaryData.min,
            salaryMax: salaryData.max,
            salaryMedian: salaryData.median,
            currency: salaryData.currency,
          },
        };
      }
    );

    return result.result;
  }
}

module.exports = new ResumeService();