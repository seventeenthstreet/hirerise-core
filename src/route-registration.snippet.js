'use strict';

/**
 * route-registration.snippet.js
 * =============================
 *
 * PURPOSE
 * -------
 * Central route registration snippet for the dual onboarding system.
 *
 * This Supabase-first version removes all Firebase / Firestore legacy
 * references and standardizes route protection using the project's
 * JWT middleware.
 *
 * ------------------------------------------------------------------
 * USAGE: Add inside app.js / server.js route registration block
 * ------------------------------------------------------------------
 *
 * Replace old users route:
 *
 *   app.use('/api/v1/users', verifySupabaseToken, require('./routes/users.routes'));
 *
 * Add new onboarding routes:
 *
 *   app.use('/api/v1/student-onboarding', verifySupabaseToken, require('./routes/student-onboarding.routes'));
 *   app.use('/api/v1/career-onboarding', verifySupabaseToken, require('./routes/career-onboarding.routes'));
 *
 * ------------------------------------------------------------------
 * COMPLETE MOUNT BLOCK (DROP-IN READY)
 * ------------------------------------------------------------------
 */

// Existing protected routes
// app.use('/api/v1/onboarding', verifySupabaseToken, onboardingRoutes);
// ... other existing routes ...

// Updated users route
app.use(
  '/api/v1/users',
  verifySupabaseToken,
  require('./routes/users.routes')
);

// New dual onboarding routes
app.use(
  '/api/v1/student-onboarding',
  verifySupabaseToken,
  require('./routes/student-onboarding.routes')
);

app.use(
  '/api/v1/career-onboarding',
  verifySupabaseToken,
  require('./routes/career-onboarding.routes')
);

/**
 * ------------------------------------------------------------------
 * SUPABASE DATABASE SCHEMA SUMMARY
 * ------------------------------------------------------------------
 *
 * public.users
 *   └─ id (uuid PK)
 *   └─ auth_user_id (uuid UNIQUE) ← references auth.users(id)
 *   └─ email
 *   └─ display_name
 *   └─ photo_url
 *   └─ tier
 *   └─ plan_amount
 *   └─ ai_credits_remaining
 *   └─ onboarding_completed
 *   └─ resume_uploaded
 *   └─ chi_score
 *   └─ subscription_status
 *   └─ subscription_provider
 *   └─ subscription_id
 *   └─ NEW: user_type ('student' | 'professional' | null)
 *   └─ NEW: student_onboarding_complete boolean default false
 *   └─ NEW: professional_onboarding_complete boolean default false
 *   └─ created_at timestamptz
 *   └─ updated_at timestamptz
 *
 * public.student_onboarding_drafts
 *   └─ auth_user_id uuid PK
 *   └─ draft_data jsonb
 *   └─ updated_at timestamptz
 *
 * public.student_career_profiles
 *   └─ auth_user_id uuid PK
 *   └─ profile_data jsonb
 *   └─ created_at timestamptz
 *
 * public.professional_career_profiles
 *   └─ auth_user_id uuid PK
 *   └─ profile_data jsonb
 *   └─ created_at timestamptz
 */