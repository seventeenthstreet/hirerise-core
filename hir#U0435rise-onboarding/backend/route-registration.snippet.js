'use strict';

/**
 * route-registration.snippet.js
 * ==============================
 *
 * Add these three lines to your main app.js / server.js file
 * where you mount all /api/v1/* routes.
 *
 * FIND the block that looks like:
 *
 *   app.use('/api/v1/users',      require('./routes/users.routes'));
 *   app.use('/api/v1/onboarding', require('./modules/onboarding/onboarding.routes'));
 *   // ... other routes ...
 *
 * ADD the two new onboarding routes next to the existing ones:
 *
 *   app.use('/api/v1/student-onboarding', verifyFirebaseToken, require('./routes/student-onboarding.routes'));
 *   app.use('/api/v1/career-onboarding',  verifyFirebaseToken, require('./routes/career-onboarding.routes'));
 *
 * REPLACE the users route with the updated version:
 *
 *   app.use('/api/v1/users', verifyFirebaseToken, require('./routes/users.routes'));
 *
 * ─── Complete mount block (copy-paste ready) ─────────────────────────────────
 */

// In your app.js / server.js, inside the route registration block:

// --- existing routes (no changes needed) ---
// app.use('/api/v1/onboarding', verifyFirebaseToken, onboardingRoutes);
// ... other existing routes ...

// --- UPDATED (replace existing users route) ---
app.use('/api/v1/users', verifyFirebaseToken, require('./routes/users.routes'));

// --- NEW: Dual Onboarding System ---
app.use('/api/v1/student-onboarding', verifyFirebaseToken, require('./routes/student-onboarding.routes'));
app.use('/api/v1/career-onboarding',  verifyFirebaseToken, require('./routes/career-onboarding.routes'));

/**
 * ─── Firestore rules additions ────────────────────────────────────────────────
 *
 * Add these collection rules to your firestore.rules:
 *
 *   // Student onboarding drafts — user can read/write own draft
 *   match /studentOnboardingDrafts/{uid} {
 *     allow read, write: if request.auth.uid == uid;
 *   }
 *
 *   // Student career profiles — readable by user and backend service
 *   match /studentCareerProfiles/{uid} {
 *     allow read: if request.auth.uid == uid;
 *     allow write: if false; // backend service account only
 *   }
 *
 *   // Professional career profiles — readable by user and backend service
 *   match /professionalCareerProfiles/{uid} {
 *     allow read: if request.auth.uid == uid;
 *     allow write: if false; // backend service account only
 *   }
 *
 * Also add to the existing /users/{uid} update rule's hasOnly([...]) list:
 *   'user_type',
 *   'student_onboarding_complete',
 *   'professional_onboarding_complete',
 *
 * ─── Database schema summary ──────────────────────────────────────────────────
 *
 * users/{uid}
 *   └─ uid, email, displayName, photoURL
 *   └─ tier, planAmount, aiCreditsRemaining
 *   └─ onboardingCompleted, resumeUploaded, chiScore
 *   └─ subscriptionStatus, subscriptionProvider, subscriptionId
 *   └─ NEW: user_type                        ('student' | 'professional' | null)
 *   └─ NEW: student_onboarding_complete      (boolean, default false)
 *   └─ NEW: professional_onboarding_complete (boolean, default false)
 *   └─ createdAt, updatedAt
 *
 * studentOnboardingDrafts/{uid}       — partial wizard state, auto-saved
 * studentCareerProfiles/{uid}         — completed student profile
 * professionalCareerProfiles/{uid}    — completed professional profile
 */
