'use strict';

/**
 * core/src/route-registration.snippet.js (PHASE 3C ADDITION)
 * ════════════════════════════════════════════════════════════
 * Add the following block to server.js alongside the existing Phase 3B
 * activities route registration.
 *
 * LOCATION: In server.js, find the activities mount added by Phase 3B:
 *
 *   app.use(
 *     '/api/v1/student-onboarding/v2/step/activities',
 *     requireAuth,
 *     requireSession,
 *     activitiesRouter,
 *   );
 *
 * Add the cognitive block directly after it.
 *
 * PREREQUISITES (already present from Phase 3B):
 *   • requireAuth middleware      — validates Bearer token, attaches req.user
 *   • requireSession middleware   — attaches req.onboardingSession + req.sessionService
 *   • req.supabase                — service-role Supabase client
 *
 * BASE PATH: /api/v1/student-onboarding/v2/step/cognitive
 */

const cognitiveRouter = require('./modules/student-onboarding/routes/cognitive.routes');

// In your Express app setup (server.js), add directly after the activities mount:
//
//   app.use(
//     '/api/v1/student-onboarding/v2/step/cognitive',
//     requireAuth,
//     requireSession,
//     cognitiveRouter,
//   );
//
// This registers the following endpoints:
//
//   GET    /api/v1/student-onboarding/v2/step/cognitive
//          Returns: { ok, taxonomy, responses, signals, signal_quality }
//          Use:     Initial load + refresh recovery
//
//   POST   /api/v1/student-onboarding/v2/step/cognitive/response
//          Body:    { question_id: uuid, selected_option_keys: string[], is_partial?: boolean }
//          Returns: { ok, response, signal_quality }
//          Use:     Progressive save — fires on every option tap
//
//   POST   /api/v1/student-onboarding/v2/step/cognitive/responses/batch
//          Body:    { responses: [{ question_id, selected_option_keys }] }
//          Returns: { ok, responses, signal_quality }
//          Use:     Multi-response batch save
//
//   POST   /api/v1/student-onboarding/v2/step/cognitive/commit
//          Body:    {}
//          Returns: { ok, signals, signal_quality }
//          Errors:  422 COGNITIVE_SIGNAL_INSUFFICIENT if required questions unanswered
//          Use:     Signal extraction + mark all responses committed
//                   Does NOT advance session (page.tsx useUpdateOnboardingStep handles that)

module.exports = { cognitiveRouter };
