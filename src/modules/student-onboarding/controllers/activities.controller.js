'use strict';

/**
 * core/src/modules/student-onboarding/controllers/activities.controller.js
 *
 * ACTIVITIES STEP CONTROLLER — Phase 3B
 * ─────────────────────────────────────
 * Thin HTTP adapter. Extracts context from req, delegates to service,
 * returns standardized JSON responses.
 *
 * DOES NOT:
 *   • contain business logic
 *   • access the database directly
 *   • validate payloads (done by middleware)
 *   • inject sessionService via req (imported directly by the service)
 *
 * ROUTE MAP (registered in activities.routes.js):
 *
 *   GET    /step/activities                              → getActivities
 *   POST   /step/activities/add                          → addActivity
 *   PUT    /step/activities/:activityKey/depth           → updateActivityDepth
 *   DELETE /step/activities/:activityKey                 → removeActivity
 *   POST   /step/activities/:activityKey/achievements    → addAchievement
 *   DELETE /step/activities/achievements/:achievementId  → removeAchievement
 *   POST   /step/activities/reflection                   → upsertReflection
 *   POST   /step/activities/commit                       → commitStep
 */

const svc = require('../services/activity.service');

// ─────────────────────────────────────────────────────────────────────────────
// GET — full step data (taxonomy + activities + achievements + signal quality)
// ─────────────────────────────────────────────────────────────────────────────

async function getActivities(req, res, next) {
  try {
    const result = await svc.getActivitiesStep(
      {
        supabase:    req.supabase,
        diagnostics: req.diagnostics,
      },
      req.user.id,
    );
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST — add a new activity (Discovery — immediate partial persist)
// ─────────────────────────────────────────────────────────────────────────────

async function addActivity(req, res, next) {
  try {
    const result = await svc.addActivity(
      { supabase: req.supabase, diagnostics: req.diagnostics },
      req.user.id,
      req.validatedActivity,
    );
    return res.status(201).json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUT — update participation depth for an existing activity
// ─────────────────────────────────────────────────────────────────────────────

async function updateActivityDepth(req, res, next) {
  try {
    const result = await svc.updateActivityDepth(
      { supabase: req.supabase, diagnostics: req.diagnostics },
      req.user.id,
      req.params.activityKey,
      req.validatedActivity,
    );
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE — remove an activity (achievements cascade via DB FK)
// ─────────────────────────────────────────────────────────────────────────────

async function removeActivity(req, res, next) {
  try {
    const result = await svc.removeActivity(
      { supabase: req.supabase },
      req.user.id,
      req.params.activityKey,
    );
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST — add an achievement to an activity
// ─────────────────────────────────────────────────────────────────────────────

async function addAchievement(req, res, next) {
  try {
    const result = await svc.addAchievement(
      { supabase: req.supabase },
      req.user.id,
      req.params.activityKey,
      req.validatedAchievement,
    );
    return res.status(201).json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE — remove a specific achievement
// ─────────────────────────────────────────────────────────────────────────────

async function removeAchievement(req, res, next) {
  try {
    await svc.removeAchievement(
      { supabase: req.supabase },
      req.user.id,
      req.params.achievementId,
    );
    return res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST — upsert reflection signals (optional Step 5)
// ─────────────────────────────────────────────────────────────────────────────

async function upsertReflection(req, res, next) {
  try {
    const result = await svc.upsertReflection(
      { supabase: req.supabase },
      req.user.id,
      req.validatedReflection,
    );
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST — commit activities step (advance session to 'cognitive')
// ─────────────────────────────────────────────────────────────────────────────

async function commitStep(req, res, next) {
  try {
    const result = await svc.commitActivitiesStep(
      { supabase: req.supabase },
      req.user.id,
      req.onboardingSession.id,
    );
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getActivities,
  addActivity,
  updateActivityDepth,
  removeActivity,
  addAchievement,
  removeAchievement,
  upsertReflection,
  commitStep,
};
