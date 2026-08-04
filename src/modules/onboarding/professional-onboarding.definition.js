'use strict';

/**
 * @file src/modules/onboarding/professional-onboarding.definition.js
 *
 * WP-PRO-08 — Professional Onboarding Definition Engine
 *
 * Canonical, backend-owned definition of Professional Onboarding: step
 * identifiers, ordering, branching, metadata, and completion-signal wiring.
 * This is the module WP-PRO-02B's ADR called for ("Option A, informed by
 * Option C") and the shape WP-PRO-03B/03C's evidence-first passes specified
 * (a branching-track model, not a false single linear array).
 *
 * OWNERSHIP (per WP-PRO-02B §5/§6):
 *   This file is the SOLE authoritative source of step identifiers, display
 *   metadata, ordering, and track membership. No other module — analytics,
 *   controllers, or the frontend — may hardcode a step id, order, or label.
 *   Consumers (professional-onboarding.progression.js, and through it
 *   onboarding.analytics.service.js#getProgress) read from this file; they
 *   do not define steps of their own.
 *
 * PURE DATA — no I/O, no DB, no HTTP. Mirrors the isolation already
 * established by domain/professionalProfile/professionalProfile.schema.js.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY BRANCHING, NOT A SINGLE LINEAR ARRAY (WP-PRO-03B §3 finding):
 * ─────────────────────────────────────────────────────────────────────────
 * Professional Onboarding is not one sequence. There is one universal
 * prerequisite (consent), a routing decision (which acquisition method the
 * user chooses), and then one of several independently-completable tracks
 * that all converge into the same normalized Professional Profile and the
 * same shared downstream chain (Career Report → CV Generation → Dashboard).
 *
 * This WP implements the two product-approved entry methods (Resume Upload,
 * Guided Profile Builder) as first-class tracks, per Task 4. The
 * pre-existing manual endpoints (POST /education-experience, POST
 * /career-intent, POST /quick-start) that predate this WP are preserved
 * as a third, backward-compatible track (LEGACY_MANUAL) so that no existing
 * user's in-progress data ever produces an empty steps[] — see Task 5.
 */

// ─────────────────────────────────────────────────────────────────────────
// Track registry
// ─────────────────────────────────────────────────────────────────────────

/**
 * Canonical track identifiers. A "track" is a distinct, independently-
 * completable onboarding path selected via an acquisition method.
 *
 * EXTENSIBILITY (Task 6 / Validation): future acquisition methods (LinkedIn,
 * GitHub, Portfolio, Enterprise HR — already recognized as no-op enum
 * values in domain/professionalProfile/professionalProfile.schema.js's
 * ACQUISITION_METHODS) are added by:
 *   1. Adding a new TRACKS entry here.
 *   2. Adding a new TRACK_STEPS[newTrack] array below.
 *   3. Adding one detector clause to detectTrack() in
 *      professional-onboarding.progression.js.
 * No existing track's definition or detection logic changes when a new
 * track is added — this is the concrete mechanism that satisfies "future
 * acquisition methods can be added by extending the definition rather than
 * rewriting onboarding logic."
 */
const TRACKS = Object.freeze({
  RESUME_UPLOAD:  'resume_upload',
  GUIDED_BUILDER: 'guided_builder',
  // Pre-existing manual entry (POST /education-experience, /career-intent,
  // /quick-start) — predates this WP, preserved for backward compatibility
  // (Task 5). Not one of the two product-approved entry methods going
  // forward, but must keep producing a populated steps[] for any user
  // already on this path.
  LEGACY_MANUAL:  'legacy_manual',
});

/**
 * Reserved for future acquisition methods (Validation / Task 6). Listed here
 * so the extensibility claim is falsifiable in code, not just in prose — an
 * enterprise implementer extending this engine adds one key per method here,
 * mirroring domain/professionalProfile/professionalProfile.schema.js's
 * ACQUISITION_METHODS enum. No TRACK_STEPS entry exists for these yet
 * because no backing route exists yet (same evidence-first standard applied
 * throughout WP-PRO-03B/03C: don't enumerate a step with no real endpoint
 * behind it).
 */
const FUTURE_TRACKS = Object.freeze({
  LINKEDIN_IMPORT:      'linkedin_import',
  GITHUB_IMPORT:        'github_import',
  PORTFOLIO_IMPORT:     'portfolio_import',
  ENTERPRISE_HR_IMPORT: 'enterprise_hr_import',
});

// ─────────────────────────────────────────────────────────────────────────
// Universal prerequisite
// ─────────────────────────────────────────────────────────────────────────

/**
 * Steps required before any track begins. Per WP-PRO-03B §3: consent is a
 * gate, not scored by evaluateCompletion(), but it is a real, listed step.
 */
const UNIVERSAL_STEPS = Object.freeze([
  Object.freeze({
    id:          'consent',
    title:       'Data & Privacy',
    description: 'Consent to data use before onboarding begins.',
    historyKey:  'consent_saved',
    required:    true,
  }),
]);

/**
 * Method-choice routing decision (WP-PRO-03C §2/§4): not a data step, has no
 * backend endpoint or step_history entry of its own — it is the moment the
 * user picks a track. Modeled as a virtual step so a user who has completed
 * consent but not yet chosen a track still sees a populated, meaningful
 * steps[] entry instead of an empty array or a silently-omitted gap.
 */
const METHOD_CHOICE_STEP = Object.freeze({
  id:          'method_choice',
  title:       'Choose Your Path',
  description: 'Choose Resume Upload or Guided Profile Builder.',
});

// ─────────────────────────────────────────────────────────────────────────
// Track-specific steps
// ─────────────────────────────────────────────────────────────────────────
//
// Each step entry:
//   id           canonical identifier (stable; frontend already tolerates
//                unknown ids per WP-PRO-02B's formatStepLabel fallback)
//   title        display label (this definition is now the single real
//                source formatStepLabel was faking string-formatting for)
//   description  short explanatory copy
//   historyKey   the exact string persisted into onboarding_progress's
//                step_history log by the real endpoint that completes this
//                step (see progression.js#isStepComplete) — omitted when a
//                step's completion must be derived rather than read
//                directly (parsing outcome, track-completion signal)
//   derivedFrom  when set, tells progression.js which derived signal to
//                consult instead of a literal history key
//   required     whether the step gates the track's own completion
//                (informational only here — evaluateCompletion in
//                onboarding.helpers.js remains the single authoritative
//                completion calculator per Task 3/"approved semantics")

const TRACK_STEPS = Object.freeze({
  // ── Entry Method 1: Resume Upload (WP-PRO-03C §3, Track A-Upload) ──────
  [TRACKS.RESUME_UPLOAD]: Object.freeze([
    Object.freeze({
      id:          'upload_resume',
      title:       'Upload Resume',
      description: 'Upload your CV (PDF, DOC, DOCX, or TXT).',
      historyKey:  'cv_uploaded',
      required:    true,
    }),
    Object.freeze({
      id:          'ai_resume_parsing',
      title:       'AI Resume Parsing',
      description: 'Your resume is parsed automatically after upload.',
      derivedFrom: 'parsingConfidence',
      required:    true,
    }),
    // WP-PRO-12C — Resume Upload does not itself collect a target role
    // (a resume has no reliable "role I want next" field to extract), so
    // Career Report generation's own "Target role required" 422 was
    // unreachable-to-satisfy for this track. This step id, historyKey,
    // and required:false are copied verbatim from
    // TRACK_STEPS[GUIDED_BUILDER]'s 'guided_career_goals' entry on
    // purpose: it is the SAME canonical Career Goals step (same
    // step-registry entry, same POST /guided/career_goals endpoint, same
    // professionalProfile.repository.js persistence — see
    // components/steps/CareerGoalsForm.tsx and constants/step-registry.ts
    // on the frontend), not a second, Resume-Upload-specific
    // implementation. Placed before 'profile_review' so it mirrors the
    // Guided Builder track's own established order (Career Goals is that
    // track's last step, immediately before the user lands on Review —
    // see CareerGoalsForm.tsx's file header).
    Object.freeze({
      id:          'guided_career_goals',
      title:       'Career Goals',
      description: 'The roles and outcomes you are targeting.',
      historyKey:  'guided_career_goals_saved',
      required:    false,
    }),
    Object.freeze({
      id:          'profile_review',
      title:       'Profile Review',
      description: 'Review the details extracted from your resume.',
      derivedFrom: 'trackAUpload',
      required:    true,
    }),
  ]),

  // ── Entry Method 2: Guided Profile Builder (WP-PRO-03C §3, Track A) ────
  // Backed today by the WP-PRO-07 Guided Builder endpoints
  // (GET /guided/profile, POST /guided/:section) — each section below maps
  // 1:1 onto a VALID_SECTIONS entry in onboarding.guidedBuilder.service.js.
  [TRACKS.GUIDED_BUILDER]: Object.freeze([
    Object.freeze({
      id:          'guided_personal_details',
      title:       'Personal Details',
      description: 'Your name, email, and contact details.',
      historyKey:  'guided_personal_details_saved',
      required:    true,
    }),
    Object.freeze({
      id:          'guided_education',
      title:       'Education',
      description: 'Your educational background.',
      historyKey:  'guided_education_saved',
      required:    true,
    }),
    Object.freeze({
      id:          'guided_experience',
      title:       'Experience',
      description: 'Your work experience.',
      historyKey:  'guided_experience_saved',
      required:    true,
    }),
    Object.freeze({
      id:          'guided_skills',
      title:       'Skills',
      description: 'Skills relevant to your target roles.',
      historyKey:  'guided_skills_saved',
      required:    false,
    }),
    Object.freeze({
      id:          'guided_career_goals',
      title:       'Career Goals',
      description: 'The roles and outcomes you are targeting.',
      historyKey:  'guided_career_goals_saved',
      required:    false,
    }),
  ]),

  // ── Legacy manual entry — backward compatibility only (Task 5) ─────────
  [TRACKS.LEGACY_MANUAL]: Object.freeze([
    Object.freeze({
      id:          'education_experience',
      title:       'Background',
      description: 'Your education and experience.',
      historyKey:  'education_experience_saved',
      required:    true,
    }),
    Object.freeze({
      id:          'career_intent',
      title:       'Career Goals',
      description: 'The roles you are targeting.',
      historyKey:  'career_intent_saved',
      required:    false,
    }),
  ]),
});

// ─────────────────────────────────────────────────────────────────────────
// Shared downstream chain (both entry methods converge here)
// ─────────────────────────────────────────────────────────────────────────
//
// Per WP-PRO-03C §2/§6: professional_profile is an internal convergence
// milestone, not a user-facing step (no step_history entry exists or
// should exist for it), so it is intentionally NOT listed here — it is
// represented only by the definition's structure (every track feeds into
// this shared block), not by an entry in steps[].

const SHARED_DOWNSTREAM_STEPS = Object.freeze([
  Object.freeze({
    id:          'career_report',
    title:       'Career Report',
    description: 'Your AI-generated career report.',
    historyKey:  'career_report_generated',
    required:    false,
  }),
  Object.freeze({
    id:          'cv_generation',
    title:       'Generate CV',
    description: 'Generate a polished CV from your profile.',
    historyKey:  'cv_generated',
    required:    false,
  }),
]);

module.exports = Object.freeze({
  TRACKS,
  FUTURE_TRACKS,
  UNIVERSAL_STEPS,
  METHOD_CHOICE_STEP,
  TRACK_STEPS,
  SHARED_DOWNSTREAM_STEPS,
});