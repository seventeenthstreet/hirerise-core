'use strict';

/**
 * core/src/modules/student-onboarding/routes/recommendation.routes.js
 *
 * ROUTE REGISTRATION — Recommendation Retry / Regeneration (Phase 1 Pass 3)
 *
 * Mounted at: /api/v1/student-onboarding/v2/recommendation  (server.js)
 *
 * authenticate + requireOnboardingSession are applied at the app.use() mount
 * in server.js, matching the academics/activities/cognitive/aspiration mount
 * pattern exactly — req.user is guaranteed set before this handler runs.
 * (req.onboardingSession itself is not read by this controller — it is
 * required only so a retry is rejected the same way every other v2 step
 * write is when no onboarding session exists yet.)
 *
 * No request body is read anywhere in this route or its controller —
 * retry/regeneration takes no client-supplied parameters (Phase 1 lifecycle
 * spec §15).
 *
 * CREDIT / RATE-LIMIT / QUOTA WIRING (Phase 1 Pass 4 — this pass):
 *   Ordering below matches the established repository convention for
 *   authenticated AI endpoints (see onboarding.routes.js's '/career-report'
 *   and '/generate-cv' routes, the only other routes in this codebase that
 *   combine all three controls):
 *
 *     aiRateLimitByPlan  → tierQuota(feature) → creditGuard(operationType)
 *
 *   `authenticate` and `requireOnboardingSession` are already applied at the
 *   app.use() mount in server.js (matching every other v2 step route), so
 *   req.user is guaranteed set before aiRateLimitByPlan ever runs — no
 *   control below can execute before authentication.
 *
 *   `studentRecommendation` is already approved and registered at zero
 *   cost in analysis.constants.js, so creditGuard('studentRecommendation')
 *   recognises the operation, skips checkAndDeductCredits()/the
 *   consume_ai_credits RPC entirely (cost === 0 branch), and calls next()
 *   — it never deducts credits, but it still runs, and it still rejects an
 *   unauthenticated request or a request for an unregistered operation name
 *   exactly as it does for every paid operation. Zero cost therefore does
 *   not mean this route skips CreditGuard, only that CreditGuard has
 *   nothing to deduct.
 *
 *   tierQuota('studentRecommendation') is not given a dedicated entry in
 *   TIER_MONTHLY_QUOTAS (tierquota.middleware.js). No repository evidence
 *   or product decision specifies a bespoke Recommendation-retry quota
 *   number, and inventing one would violate spec §8's "do not add
 *   arbitrary quota values." tierQuota's existing, already-shipped
 *   fallback semantics apply instead, via getQuotaLimit()'s
 *   `feature in conf ? conf[feature] : ('default' in conf ? conf.default : 10)`
 *   — the SAME fallback path '/career-report' (tierQuota('careerReport'))
 *   and '/generate-cv' (tierQuota('generateCV')) already go through in
 *   production for this exact feature-not-registered case.
 *
 *   AUDIT NOTE (Tier Quota Fallback Semantics pass — RESOLVED):
 *   getQuotaLimit() previously resolved unregistered features via
 *   `conf.default ?? 10`, which coerced pro/premium/enterprise's
 *   deliberate `default: null` (this codebase's established "unmetered"
 *   convention) into a 10/month cap — meaning `studentRecommendation`
 *   (and careerReport/generateCV) retries were capped at 10/month even on
 *   paid tiers. That dedicated audit pass found unambiguous, multi-source
 *   repository evidence that `null` means unmetered here (tierQuota's own
 *   other null-checks, analysis.constants.js's documented "unmetered"
 *   convention, and aiRateLimitByPlan.middleware.js's identical
 *   `enterprise: null // unlimited` pattern) and fixed getQuotaLimit()
 *   accordingly — see tierquota.middleware.js for the full evidence trail.
 *   pro/premium/enterprise are now correctly unmetered for
 *   studentRecommendation (and every other unregistered-feature AI
 *   operation); `free` tier behavior is completely unchanged (still 10).
 *
 *   aiRateLimitByPlan is plan-scoped and operation-agnostic (one shared
 *   daily AI-request bucket per user across all AI operations); it applies
 *   to this route the same way it already does to '/career-report' and
 *   '/generate-cv'.
 *
 *   Rejection ordering: every one of these three checks runs — and can
 *   reject the request — strictly before `retryRecommendation` (and
 *   therefore before `recommendationEngine.initiateRetry()`) ever executes,
 *   because Express only calls the next handler in the chain once the
 *   current one calls next() without an error. A 429/402/500 short-circuit
 *   from any control below therefore cannot mutate Recommendation lifecycle
 *   state (spec §10) — see recommendation.routes.middleware.test.js.
 */

const { Router } = require('express');
const { aiRateLimitByPlan } = require('../../../middleware/aiRateLimitByPlan.middleware');
const { tierQuota } = require('../../../middleware/tierquota.middleware');
const { creditGuard } = require('../../../middleware/creditGuard.middleware');
const { retryRecommendation } = require('../controllers/recommendation.controller');

const router = Router();

// POST /api/v1/student-onboarding/v2/recommendation/retry
router.post(
  '/retry',
  aiRateLimitByPlan,
  tierQuota('studentRecommendation'),
  creditGuard('studentRecommendation'),
  retryRecommendation,
);

module.exports = router;
