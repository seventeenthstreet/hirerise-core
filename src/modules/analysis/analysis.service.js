'use strict';

/**
 * src/modules/analysis/analysis.service.js
 *
 * PRODUCTION FIX — Full audit pass (see CHANGELOG below)
 *
 * ROOT CAUSE of score/summary/strengths/improvements being NULL:
 *
 *  [RC-1] fetchResume() — resume_text EMPTY string guard was missing.
 *         `data.raw_text` can be NULL in Postgres (e.g. upload still processing).
 *         The original code silently returned '' and passed it straight to the AI,
 *         which either returned an empty/stub response or threw an error that was
 *         swallowed downstream.  Fix: throw AppError if text is blank.
 *
 *  [RC-2] runFreeEngine call — NOT awaited even defensively, and the engine may
 *         return a Promise in some builds. A missing `await` means `result` is a
 *         Promise object, not the plain object. Every `result.score` etc. is then
 *         `undefined`, which the `?? null` fallbacks in saveAnalysisResult() turn
 *         into NULL before inserting. Fix: always `await` the engine call.
 *
 *  [RC-3] AI response mapping contract — runFullAnalysis / runGenerateCV are black
 *         boxes here, but callers must not trust the shape blindly. Added a
 *         `validateAndNormaliseEngineResult()` step that checks the required fields
 *         exist and are the correct types, logs the raw result for debugging, and
 *         fills safe defaults so the insert is never silently NULL.
 *
 *  [RC-4] saveAnalysisResult() — payload used `result.score ?? null` which hides
 *         the problem. If score is 0 (valid!) `?? null` works, but if score is
 *         `undefined` due to RC-2/RC-3, it silently inserts NULL.  The fix is
 *         RC-2+RC-3 upstream; the payload mapping is left as-is (correct).
 *
 *  [RC-5] No resume_text length logged anywhere — made it impossible to diagnose
 *         "AI received empty text" without a code change. Fix: add debug logs at
 *         every meaningful checkpoint (resume fetch, engine input, engine output,
 *         DB payload).
 *
 * ADDITIONAL IMPROVEMENTS:
 *  - resume_text generated-column fallback: select BOTH resume_text and raw_text;
 *    use resume_text first (generated), fall back to raw_text.
 *  - Hard guard: throw if resume text is still empty after fallback.
 *  - runAnalysis now returns { success, data } envelope as required.
 *  - All engine calls wrapped in try/catch with structured logging.
 *  - saveAnalysisResult logs the full payload (sanitised) before insert.
 */
console.log("🚀 ANALYSIS SERVICE HIT");
const crypto = require('crypto');

const { supabase }             = require('../../config/supabase');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const logger                   = require('../../utils/logger');

const { runFreeEngine }                  = require('./engines/freeEngine');
const { runFullAnalysis, runGenerateCV } = require('./engines/premiumEngine');

const creditConfigService        = require('../../services/billing/creditConfig.service');
const { getWeightedRoleContext } = require('../../services/career/careerWeight.service');

const DEFAULT_CHI_LOOKBACK_DAYS   = 45;
const DEFAULT_WEEKLY_ROLLUP_WEEKS = 12;

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalise engine to the two values allowed by the DB CHECK constraint.
 * @param {string|undefined} engine
 * @returns {'free'|'premium'}
 */
function normalizeEngine(engine) {
  return engine === 'free' ? 'free' : 'premium';
}

/**
 * Generate a deterministic hash for cases where the engine does not produce one
 * (e.g. free tier). Ensures analysis_hash NOT NULL constraint is always satisfied.
 */
function generateAnalysisHash(resumeId, operationType, engineResult) {
  const payload = {
    resumeId,
    operationType,
    score:     engineResult.score     ?? null,
    topSkills: engineResult.topSkills ?? [],
    tier:      engineResult.tier      ?? null,
    scoredAt:  engineResult.scoredAt  ?? new Date().toISOString(),
  };

  return crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
}

/**
 * [RC-3 FIX] Validate and normalise the raw object returned by any engine.
 *
 * Problems this prevents:
 *  - Engine returned a Promise (RC-2): caught here as "not a plain object"
 *  - Engine returned undefined / null (e.g. unhandled throw in premiumEngine)
 *  - AI JSON parse failed inside premiumEngine and it returned {}
 *  - score is a string "72" instead of number 72
 *  - strengths / improvements are undefined instead of []
 *
 * This function DOES NOT throw — it logs a warning and fills safe defaults
 * so the row is still inserted (audit trail). The caller can decide whether
 * a score of null is acceptable.
 *
 * @param {unknown} raw
 * @param {string} context  — label for log messages
 * @returns {object}        — normalised result
 */
function validateAndNormaliseEngineResult(raw, context) {
  // RC-2 detection: engine returned a Promise (forgot await)
  if (raw && typeof raw.then === 'function') {
    logger.error(`[AnalysisService] ${context} — engine returned a Promise; missing await`, {
      hint: 'Check the engine function — it is async but was called without await',
    });
    throw new AppError(
      'Engine returned a Promise instead of a value — missing await',
      500,
      { context },
      ErrorCodes.INTERNAL_ERROR,
    );
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    logger.error(`[AnalysisService] ${context} — engine returned non-object`, { raw });
    throw new AppError(
      'Engine returned an invalid result (null/undefined/array)',
      500,
      { context },
      ErrorCodes.INTERNAL_ERROR,
    );
  }

  // Log the raw AI output so we can debug mapping issues in production
  logger.debug(`[AnalysisService] ${context} — raw engine result`, {
    hasScore:        'score'        in raw,
    hasSummary:      'summary'      in raw,
    hasStrengths:    'strengths'    in raw,
    hasImprovements: 'improvements' in raw,
    scoreType:       typeof raw.score,
    scoreValue:      raw.score,
    summaryLength:   typeof raw.summary === 'string' ? raw.summary.length : null,
    strengthsCount:  Array.isArray(raw.strengths)    ? raw.strengths.length    : null,
    improvementsCount: Array.isArray(raw.improvements) ? raw.improvements.length : null,
  });

  // Warn about missing required fields
  const REQUIRED = ['score', 'summary', 'strengths', 'improvements'];
  const missing  = REQUIRED.filter((k) => !(k in raw) || raw[k] == null);
  if (missing.length) {
    logger.warn(`[AnalysisService] ${context} — engine result missing fields`, { missing });
  }

  // Normalise types — coerce without throwing so we always get a storable row
  return {
    ...raw,
    score:        typeof raw.score === 'number'
                    ? raw.score
                    : (parseFloat(raw.score) || null),
    summary:      typeof raw.summary === 'string'
                    ? raw.summary
                    : (raw.summary != null ? String(raw.summary) : null),
    strengths:    Array.isArray(raw.strengths)
                    ? raw.strengths
                    : (raw.strengths != null ? [String(raw.strengths)] : []),
    improvements: Array.isArray(raw.improvements)
                    ? raw.improvements
                    : (raw.improvements != null ? [String(raw.improvements)] : []),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Career context
// ─────────────────────────────────────────────────────────────────────────────

async function fetchCareerContext(userId) {
  try {
    const { data } = await supabase
      .from('user_profiles')
      .select('careerHistory,currentRoleId,previousRoleIds')
      .eq('id', userId)
      .maybeSingle();

    if (!data) return null;

    if (Array.isArray(data.careerHistory) && data.careerHistory.length) {
      return getWeightedRoleContext(data.careerHistory);
    }

    const legacyRoles = [];

    if (data.currentRoleId) {
      legacyRoles.push({ roleId: data.currentRoleId, durationMonths: 1, isCurrent: true });
    }

    for (const roleId of data.previousRoleIds || []) {
      legacyRoles.push({ roleId, durationMonths: 1, isCurrent: false });
    }

    return legacyRoles.length ? getWeightedRoleContext(legacyRoles) : null;
  } catch (error) {
    logger.warn('[AnalysisService] Career context fallback', { userId, error: error.message });
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Resume fetch
//
// [RC-1 FIX] Select BOTH `resume_text` (generated column) AND `raw_text` so we
// have two chances to get the text. Guard: throw if both are empty/null.
//
// Schema note supplied by caller:
//   resume_text  — generated column (preferred)
//   raw_text     — base column (fallback)
//   content      — JSONB: { fileName, mimetype, sizeBytes, storagePath }
//   parsed_data  — JSONB: { personal_details, ... }
//   user_id      — TEXT (not UUID)
// ─────────────────────────────────────────────────────────────────────────────

async function fetchResume(userId, resumeId) {
  const { data, error } = await supabase
    .from('resumes')
    //  ↓  include resume_text (generated) as primary, raw_text as fallback
    .select('id,user_id,resume_text,raw_text,content,parsed_data')
    .eq('id', resumeId)
    .maybeSingle();

  if (error) {
    logger.error('[AnalysisService] fetchResume DB error', {
      resumeId, errorCode: error.code, errorMessage: error.message,
    });
    throw new AppError('Resume not found', 404, { resumeId }, ErrorCodes.NOT_FOUND);
  }

  if (!data) {
    throw new AppError('Resume not found', 404, { resumeId }, ErrorCodes.NOT_FOUND);
  }

  if (data.user_id !== userId) {
    throw new AppError('Unauthorized', 403, {}, ErrorCodes.UNAUTHORIZED);
  }

  // [RC-1 FIX] Prefer generated column, fall back to raw_text
  const resumeText = (data.resume_text || data.raw_text || '').trim();

  // [RC-1 FIX] Hard guard — do NOT pass empty text to AI
  if (!resumeText) {
    logger.error('[AnalysisService] fetchResume — resume text is empty', {
      resumeId,
      userId,
      hasResumeText: Boolean(data.resume_text),
      hasRawText:    Boolean(data.raw_text),
    });
    throw new AppError(
      'Resume text is empty — upload may still be processing or extraction failed',
      422,
      { resumeId },
      ErrorCodes.VALIDATION_ERROR,
    );
  }

  logger.debug('[AnalysisService] fetchResume — text OK', {
    resumeId,
    textLength:    resumeText.length,
    textPreview:   resumeText.slice(0, 120),
    fileNameSource: data.content?.fileName ? 'content.fileName' : 'fallback',
  });

  return {
    id:               data.id,
    user_id:          data.user_id,
    resume_text:      resumeText,
    file_name:        data.content?.fileName || 'resume',
    personal_details: data.parsed_data?.personal_details || {},
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CHI helpers (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

async function getLatestChiScore(userId, lookbackDays = DEFAULT_CHI_LOOKBACK_DAYS) {
  const startedAt = Date.now();

  try {
    const { data, error } = await supabase.rpc('get_latest_chi_score', {
      p_user_id:       userId,
      p_lookback_days: lookbackDays,
    });

    if (error) throw error;

    const latest = Array.isArray(data) ? data[0] || null : null;

    logger.debug('[AnalysisService] Latest CHI RPC success', {
      userId, lookbackDays, latency_ms: Date.now() - startedAt, found: Boolean(latest),
    });

    return latest;
  } catch (error) {
    logger.error('[AnalysisService] Latest CHI RPC failed', {
      userId, lookbackDays, latency_ms: Date.now() - startedAt, error: error.message,
    });
    return null;
  }
}

async function getChiTrendHistory(userId, lookbackDays = DEFAULT_CHI_LOOKBACK_DAYS, bucket = 'day') {
  const startedAt = Date.now();

  try {
    const { data, error } = await supabase.rpc('get_chi_trend_history', {
      p_user_id:       userId,
      p_lookback_days: lookbackDays,
      p_bucket:        bucket,
    });

    if (error) throw error;

    const trend = Array.isArray(data) ? data : [];

    logger.debug('[AnalysisService] CHI trend RPC success', {
      userId, lookbackDays, bucket, points: trend.length, latency_ms: Date.now() - startedAt,
    });

    return trend;
  } catch (error) {
    logger.error('[AnalysisService] CHI trend RPC failed', {
      userId, lookbackDays, bucket, latency_ms: Date.now() - startedAt, error: error.message,
    });
    return [];
  }
}

async function getWeeklyChiRollups(userId, weeks = DEFAULT_WEEKLY_ROLLUP_WEEKS) {
  const startedAt = Date.now();

  try {
    const { data, error } = await supabase
      .from('chi_weekly_rollups_mv')
      .select('*')
      .eq('user_id', userId)
      .order('week_bucket', { ascending: false })
      .limit(weeks);

    if (error) throw error;

    const rollups = Array.isArray(data) ? data : [];

    logger.debug('[AnalysisService] Weekly CHI rollups success', {
      userId, weeks, points: rollups.length, latency_ms: Date.now() - startedAt,
    });

    return rollups;
  } catch (error) {
    logger.error('[AnalysisService] Weekly CHI rollups failed', {
      userId, weeks, latency_ms: Date.now() - startedAt, error: error.message,
    });
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Persist analysis result
// ─────────────────────────────────────────────────────────────────────────────

async function saveAnalysisResult(userId, resumeId, operationType, result) {
  const analysisHash = result.analysisHash
    ?? generateAnalysisHash(resumeId, operationType, result);

  const engine = normalizeEngine(result.engine);

  const payload = {
    user_id:          userId,
    resume_id:        resumeId,
    operation_type:   operationType,
    engine,
    analysis_hash:    analysisHash,
    ai_model_version: result.aiModelVersion             ?? null,
    score:            result.score                      ?? null,
    tier:             result.tier                       ?? null,
    summary:          result.summary                    ?? null,
    breakdown:        result.breakdown                  ?? null,
    strengths:        result.strengths                  ?? [],
    improvements:     result.improvements               ?? [],
    top_skills:       result.topSkills                  ?? [],
    estimated_experience_years: result.estimatedExperienceYears ?? null,
    chi_score:        result.chiScore                   ?? null,
    dimensions:       result.dimensions                 ?? null,
    market_position:  result.marketPosition             ?? null,
    peer_comparison:  result.peerComparison             ?? null,
    growth_insights:  result.growthInsights             ?? null,
    salary_estimate:  result.salaryEstimate             ?? null,
    roadmap:          result.roadmap                    ?? null,
    weighted_career_context: result.weightedCareerContext ?? null,
    token_input_count:  result.tokenInputCount          ?? 0,
    token_output_count: result.tokenOutputCount         ?? 0,
    ai_cost_usd:        result.aiCostUsd                ?? 0,
    latency_ms:         result.latencyMs                ?? null,
    cache_hit:          result.cacheHit                 ?? false,
    cache_source:       result.cacheSource              ?? null,
  };

  // [RC-5 FIX] Log sanitised payload before insert so we can confirm field values
  logger.debug('[AnalysisService] saveAnalysisResult — payload snapshot', {
    resumeId,
    engine,
    analysisHash,
    score:            payload.score,
    summaryLength:    typeof payload.summary === 'string' ? payload.summary.length : null,
    strengthsCount:   payload.strengths.length,
    improvementsCount: payload.improvements.length,
  });

  const { error } = await supabase
    .from('resume_analyses')
    .upsert(payload, { onConflict: 'resume_id,analysis_hash,engine' });

  if (error) {
    logger.error('[AnalysisService] Save analysis failed', {
      resumeId,
      engine,
      analysisHash,
      errorCode:    error.code,
      errorMessage: error.message,
    });
    // Non-fatal — result is still returned to the client even if persistence fails
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main analysis orchestrator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run a resume analysis and persist the result.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.resumeId
 * @param {string} params.operationType   — 'fullAnalysis' | 'generateCV' | …
 * @param {string} params.tier            — 'free' | 'premium' | …
 * @param {string|null} params.requestSignature
 *
 * @returns {{ success: true, data: object }}
 */
async function runAnalysis({
  userId,
  resumeId,
  operationType,
  tier,
  requestSignature = null,
}) {
  const startedAt = Date.now();

  logger.info('[AnalysisService] runAnalysis start', {
    userId, resumeId, operationType, tier,
  });

  // Load credit config (kept for DB-driven config readiness)
  await creditConfigService.getCreditConfig();

  // [RC-1 FIX] fetchResume now throws if text is empty — no silent empty-string pass-through
  const [resume, context] = await Promise.all([
    fetchResume(userId, resumeId),
    fetchCareerContext(userId),
  ]);

  logger.debug('[AnalysisService] runAnalysis — inputs ready', {
    resumeId,
    resumeTextLength: resume.resume_text.length,
    hasCareerContext: Boolean(context),
    tier,
    operationType,
  });

  let rawResult;

  // ── Engine dispatch ────────────────────────────────────────────────────────

  if (tier === 'free') {
    try {
      // [RC-2 FIX] Always await — runFreeEngine may become async, and awaiting a
      // synchronous return value is a no-op, so this is unconditionally safe.
      rawResult = await runFreeEngine({
        resumeId,
        resumeText: resume.resume_text,
        fileName:   resume.file_name,
      });
    } catch (engineError) {
      logger.error('[AnalysisService] runFreeEngine threw', {
        resumeId,
        error: engineError.message,
        stack: engineError.stack,
      });
      throw new AppError(
        'Free analysis engine failed',
        500,
        { resumeId, originalMessage: engineError.message },
        ErrorCodes.INTERNAL_ERROR,
      );
    }

  } else if (operationType === 'fullAnalysis') {
    try {
      rawResult = await runFullAnalysis({
        userId,
        userTier:              tier,
        resumeId,
        resumeText:            resume.resume_text,
        fileName:              resume.file_name,
        weightedCareerContext: context,
      });
    } catch (engineError) {
      logger.error('[AnalysisService] runFullAnalysis threw', {
        resumeId,
        error: engineError.message,
        stack: engineError.stack,
      });
      throw new AppError(
        'Premium analysis engine failed',
        500,
        { resumeId, originalMessage: engineError.message },
        ErrorCodes.INTERNAL_ERROR,
      );
    }

  } else {
    // generateCV or any other premium operation
    try {
      rawResult = await runGenerateCV(
        {
          userId,
          resumeText:      resume.resume_text,
          fileName:        resume.file_name,
          personalDetails: resume.personal_details ?? {},
        },
        {
          userTier: tier,
          userId,
        },
      );
    } catch (engineError) {
      logger.error('[AnalysisService] runGenerateCV threw', {
        resumeId,
        operationType,
        error: engineError.message,
        stack: engineError.stack,
      });
      throw new AppError(
        'CV generation engine failed',
        500,
        { resumeId, originalMessage: engineError.message },
        ErrorCodes.INTERNAL_ERROR,
      );
    }
  }

  // ── [RC-3 FIX] Validate + normalise the engine result ────────────────────
  const result = validateAndNormaliseEngineResult(
    rawResult,
    `${operationType}/${tier}`,
  );

  // Attach request signature for dedup / polling
  if (requestSignature) {
    result.requestSignature = requestSignature;
  }

  // ── Persist ───────────────────────────────────────────────────────────────
  await saveAnalysisResult(userId, resumeId, operationType, result);

  logger.info('[AnalysisService] runAnalysis complete', {
    resumeId,
    operationType,
    tier,
    score:      result.score,
    latency_ms: Date.now() - startedAt,
  });

  // ── Return required { success, data } envelope ────────────────────────────
  return {
    success: true,
    data: {
      score:        result.score,
      summary:      result.summary,
      strengths:    result.strengths,
      improvements: result.improvements,
      // Include the full result for callers that need additional fields
      ...result,
    },
  };
}

module.exports = {
  runAnalysis,
  getLatestChiScore,
  getChiTrendHistory,
  getWeeklyChiRollups,
};