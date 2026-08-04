/**
 * @file src/modules/student-onboarding/recommendation-engine.js
 *
 * PHASE 1 MVP — STUDENT RECOMMENDATION ENGINE
 * ════════════════════════════════════════════
 * Called by POST /api/student-onboarding/generate-recommendations
 *
 * PIPELINE:
 *   1. Fetch all student profile data from Supabase
 *   2. Build a structured assessment context
 *   3. Call Claude (claude-sonnet-4-20250514) with the context
 *   4. Parse and validate the structured JSON output
 *   5. Store in student_recommendation_results
 *   6. Advance session to 'result'
 *
 * AI-ERA GUIDANCE RULES (enforced in prompt):
 *   - NEVER say "this career is dead"
 *   - ALWAYS use: "evolving rapidly, requires continuous upskilling"
 *   - Avoid fear-based language; use opportunity-based framing
 *   - All recommendations must include human-edge and AI disruption scores
 *
 * FINANCIAL AWARENESS RULES:
 *   - affordabilityFit must reflect the student's stated budget
 *   - Recommend government schemes / scholarships when budget is under_1l or 1_3l
 *   - Never recommend only premium colleges for budget-constrained students
 */

'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
// Node 20 has no native global WebSocket — required by RealtimeClient at
// construction time even when realtime isn't used. This module is required
// eagerly by student-onboarding.routes.js at server boot, so without this
// the whole server crashes on startup. See config/supabase.js.
const WebSocket = require('ws');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Supabase admin client (bypasses RLS for backend reads)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { realtime: { transport: WebSocket } },
);

// ─────────────────────────────────────────────────────────────────────────────
// DATA AGGREGATION
// ─────────────────────────────────────────────────────────────────────────────

async function fetchStudentContext(userId) {
  const [
    { data: session },
    { data: education },
    { data: academics },
    { data: interests },
    { data: learningStyle },
    { data: exposure },
    { data: financial },
  ] = await Promise.all([
    supabase.from('student_onboarding_sessions').select('*').eq('user_id', userId).single(),
    supabase.from('student_education_profiles').select('*').eq('user_id', userId).maybeSingle(),
    supabase.from('student_academics_profiles').select('*').eq('user_id', userId).maybeSingle(),
    supabase.from('student_interests_profiles').select('*').eq('user_id', userId).maybeSingle(),
    supabase.from('student_learning_styles').select('*').eq('user_id', userId).maybeSingle(),
    supabase.from('student_exposure_profiles').select('*').eq('user_id', userId).maybeSingle(),
    supabase.from('student_financial_profiles').select('*').eq('user_id', userId).maybeSingle(),
  ]);

  return { session, education, academics, interests, learningStyle, exposure, financial };
}

// ─────────────────────────────────────────────────────────────────────────────
// PROMPT BUILDER
// ─────────────────────────────────────────────────────────────────────────────

function buildAssessmentPrompt(ctx) {
  const { education, academics, interests, learningStyle, exposure, financial } = ctx;

  // Parse JSONB fields
  const subjectsJson = academics?.subjects_json
    ? (typeof academics.subjects_json === 'string' ? JSON.parse(academics.subjects_json) : academics.subjects_json)
    : {};

  const responsesJson = learningStyle?.responses_json
    ? (typeof learningStyle.responses_json === 'string' ? JSON.parse(learningStyle.responses_json) : learningStyle.responses_json)
    : [];

  return `You are HireRise's career intelligence AI, helping a student in India plan their future career path.

You must generate a comprehensive, personalised career recommendation report based on the student's full assessment profile below.

## STUDENT PROFILE

### Education Context
- Class: ${education?.education_level ?? 'unknown'}
- Board: ${education?.board_type ?? 'not specified'}
- School Type: ${education?.school_type ?? 'not specified'}

### Academic Snapshot
Subject performance bands (weak/average/strong/excellent):
${Object.entries(subjectsJson).map(([subject, data]) => `- ${subject}: current=${data.current}, confidence=${data.confidence}`).join('\n') || 'Not provided'}
Favourite subjects: ${academics?.favourite_subjects?.join(', ') || 'None specified'}
Challenging subjects: ${academics?.challenging_subjects?.join(', ') || 'None specified'}

### Interests (selected cards)
${interests?.selected_cards?.join(', ') || 'Not provided'}
Dominant interest clusters: ${interests?.dominant_clusters?.join(', ') || 'Not derived'}

### Learning & Working Style
Thinking style: ${learningStyle?.thinking_style ?? 'not determined'}
Scenario responses:
${responsesJson.map(r => `- ${r.scenarioId}: ${r.response}`).join('\n') || 'Not provided'}

### Exposure & Activities
Activities: ${exposure?.activities?.join(', ') || 'None specified'}
Hours per week: ${exposure?.hours_per_week ?? 'not specified'}
Leadership experience: ${exposure?.has_leadership_role === true ? 'Yes' : exposure?.has_leadership_role === false ? 'No' : 'Not specified'}

### Financial Context
Education budget: ${financial?.education_budget ?? 'not specified'}
Loan openness: ${financial?.loan_openness ?? 'not specified'}
Relocation flexibility: ${financial?.relocation_flexibility ?? 'not specified'}

---

## YOUR TASK

Generate a structured JSON career recommendation report. Return ONLY valid JSON, no markdown, no preamble.

The JSON must exactly match this TypeScript type structure:

\`\`\`
{
  strengthSummary: {
    traits: string[],           // 3-5 traits (e.g. "analytical thinker", "creative problem solver")
    academicInsights: string[], // 2-3 observations about academic pattern
    exposureHighlights: string[] // 2-3 observations about activities
  },
  streamScores: [
    { stream: "science"|"commerce"|"humanities", score: number(0-100), label: string, rationale: string }
  ],
  recommendedDomains: [          // 3-5 domains, ranked by fit
    {
      id: string,                // slug like "ai-engineering"
      title: string,             // e.g. "AI Engineering & Data Science"
      description: string,       // 1-2 sentences
      whyItFitsYou: string,      // personalised explanation using their actual profile data
      futureScore: number(0-100),      // industry growth score
      aiRiskScore: number(0-100),      // automation risk (LOWER = safer)
      humanEdgeScore: number(0-100),   // how much this needs human creativity
      employabilityScore: number(0-100),
      roiPotential: "low"|"medium"|"high"|"very_high",
      globalOpportunity: "local"|"national"|"global",
      affordabilityFit: "tight"|"good"|"excellent",  // based on their budget
      exampleRoles: string[],    // 3-4 specific job titles
      entryPaths: string[],      // 3-4 actionable steps to pursue this
      aiEraGuidance: string      // MUST be encouraging, NOT fear-based
    }
  ],
  financialInsights: {
    affordabilityNote: string,        // 1-2 sentences on budget fit
    loanConsideration: string|null,   // only if relevant
    roiObservation: string,           // 1-2 sentences on earnings potential
    scholarshipSuggestion: string|null // suggest specific scholarships if budget is tight
  },
  futureCareerNote: string  // 2-3 sentences on AI era, must be encouraging not scary
}
\`\`\`

## CRITICAL RULES

1. NEVER say any career is "dying" or "dead". Use: "evolving rapidly and requiring continuous upskilling and AI collaboration."
2. affordabilityFit must reflect the student's actual budget (${financial?.education_budget ?? 'unknown'}).
3. If budget is "under_1l" or "1_3l", recommend government colleges / scholarships — NEVER suggest only premium private colleges.
4. whyItFitsYou MUST reference actual data from THIS student's profile — not generic text.
5. streamScores must include all three streams (science, commerce, humanities), summing to a reasonable distribution.
6. Return ONLY the JSON object. No markdown fences. No explanation.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// AI GENERATION
// ─────────────────────────────────────────────────────────────────────────────

async function generateRecommendations(userId) {
  console.log(`[recommendation-engine] Starting for user: ${userId}`);

  // 1. Fetch student data
  const ctx = await fetchStudentContext(userId);

  if (!ctx.session) {
    throw new Error(`No onboarding session found for user ${userId}`);
  }

  // 2. Build prompt
  const prompt = buildAssessmentPrompt(ctx);

  // 3. Call Claude
  console.log(`[recommendation-engine] Calling Claude for user: ${userId}`);
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });

  const rawText = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

  // 4. Parse and validate JSON
  let result;
  try {
    // Strip any accidental markdown fences
    const cleaned = rawText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    result = JSON.parse(cleaned);
  } catch (err) {
    console.error(`[recommendation-engine] JSON parse failed for user ${userId}:`, rawText.slice(0, 500));
    throw new Error(`Failed to parse recommendation JSON: ${err.message}`);
  }

  // 5. Validate minimum structure
  if (!result.strengthSummary || !result.streamScores || !result.recommendedDomains) {
    throw new Error('Recommendation result is missing required fields');
  }

  // 6. Store result in Supabase
  const fullResult = {
    userId,
    generatedAt: new Date().toISOString(),
    ...result,
  };

  const topDomain = result.recommendedDomains[0];
  const topStream = result.streamScores.reduce((best, s) => s.score > best.score ? s : best, result.streamScores[0]);

  const { error: insertError } = await supabase
    .from('student_recommendation_results')
    .upsert(
      {
        user_id:        userId,
        result_json:    JSON.stringify(fullResult),
        engine_version: 'v1',
        top_domain_id:  topDomain?.id ?? null,
        top_stream:     topStream?.stream ?? null,
        generated_at:   new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    );

  if (insertError) {
    throw new Error(`Failed to store recommendation result: ${insertError.message}`);
  }

  // 7. Advance session to 'result'
  const { error: sessionError } = await supabase
    .from('student_onboarding_sessions')
    .update({
      current_step: 'result',
      updated_at:   new Date().toISOString(),
    })
    .eq('user_id', userId);

  if (sessionError) {
    throw new Error(`Failed to advance session to result: ${sessionError.message}`);
  }

  console.log(`[recommendation-engine] Complete for user: ${userId}`);
  return fullResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPRESS ROUTE HANDLER
// Register as: POST /api/student-onboarding/generate-recommendations
// ─────────────────────────────────────────────────────────────────────────────

async function handleGenerateRecommendations(req, res) {
  try {
    const { userId } = req.body;

    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({ error: 'userId is required' });
    }

    const result = await generateRecommendations(userId);
    return res.status(200).json({ success: true, result });
  } catch (err) {
    console.error('[recommendation-engine] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}

module.exports = {
  generateRecommendations,
  handleGenerateRecommendations,
};
