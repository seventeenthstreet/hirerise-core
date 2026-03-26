/**
 * server.js — HireRise Core Engine Entry Point (HARDENED VERSION)
 *
 * Fixes applied:
 *  - Removed duplicate middleware registrations (helmet, compression, cors,
 *    correlationMiddleware, rate limiter were all registered twice)
 *  - Removed unconditional dev route registration (now non-production only)
 *  - Auth applied per route group (fixes 401-before-404 ordering bug)
 *  - requireAdmin exported from auth.middleware (fixes silent 403 bug)
 *  - Stripe raw body parsing before express.json (webhook sig verification)
 *  - Webhook routes registered before protected routes (no auth required)
 *  - Admin metrics + admin AI routes registered with requireAdmin guard
 *
 * Two-tier admin system (new):
 *  - contributor role: submit entries for review via /admin/pending
 *  - admin+: approve/reject entries, manage contributors via /admin/contributors
 *  - requireContributor middleware gates submission endpoints
 *
 * Education Intelligence (Step 4):
 *  - student.routes    → onboarding data collection (POST student/academics/activities/cognitive)
 *  - analysis.routes   → AI engine pipeline (POST/GET analyze/:studentId)
 *
 * University & Employer Integration Platform (Step 5):
 *  - university.routes     → university registration, program management, aggregated student insights
 *  - employer.routes       → employer registration, job role management, anonymised talent pipeline
 *  - opportunities.routes  → AI-matched university + job opportunities per student
 *
 * Semantic AI Upgrade (Step 6):
 *  - semantic.routes       → skill embeddings, semantic job matching, AI career advisor, learning paths
 *  - Controlled by FEATURE_SEMANTIC_MATCHING=true
 *
 * AI Career Opportunity Radar (Step 7):
 *  - opportunityRadar.routes → emerging roles, opportunity scores, personalised radar
 *
 * AI Event Bus — Async Pipeline (Step 8):
 *  - aiEventBus.routes     → trigger + result + polling endpoints for async AI workers
 *  - BullMQ workers started at boot when FEATURE_EVENT_BUS=true
 *
 * AI Personalization Engine (Step 9):
 *  - personalization.routes  → behavior tracking, personalized recommendations
 *  - Personalization worker started at boot when FEATURE_PERSONALIZATION=true
 *
 * Career Copilot RAG System (Step 10):
 *  - careerCopilot.routes  → RAG-grounded conversational AI (hallucination-prevented)
 *
 * Daily Engagement System (Step 11):
 *  - engagementRouter      → daily insights, career progress tracker, opportunity alerts
 *  - startEngagementWorker → BullMQ worker (inline when RUN_ENGAGEMENT_WORKER=true)
 *  - Env: ENGAGEMENT_CACHE_TTL_SEC, RUN_ENGAGEMENT_WORKER, ENGAGEMENT_WORKER_CONCURRENCY
 */

'use strict';

// ── Environment validation — MUST be first ────────────────────────────────────
// Validates all required environment variables before anything else loads.
// Server will not start if required variables are missing or malformed.
// See config/env.js for the full list of validated variables.
require('dotenv').config();
require('./config/env');

// Firebase removed — authentication now handled by Supabase JWT verification.
// See src/middleware/auth.middleware.js for the Supabase-based token check.

// Core dependencies
const express     = require('express');
const helmet      = require('helmet');
const compression = require('compression');
const cors        = require('cors');
const morgan      = require('morgan');
const rateLimit   = require('express-rate-limit');

// Utilities
const logger = require('./utils/logger');

// Middleware
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { correlationMiddleware } = require('./middleware/correlation.middleware');
const { authenticate, requireAdmin } = require('./middleware/auth.middleware');
const { requireMasterAdmin } = require('./middleware/requireMasterAdmin.middleware');
const { requireContributor } = require('./middleware/requireContributor.middleware');
const { adminRateLimit, masterRateLimit } = require('./middleware/adminRateLimit.middleware');

// Routes
const devRoutes = require('./modules/dev/dev.routes');
const { secretsRouter }    = require('./modules/secrets');
const marketIntelRouter    = require('./modules/marketIntelligence/marketIntelligence.routes');
const { skillDemandRouter } = require('./modules/skillDemand');

// ── Intent Gateway — direction preference routes (additive, no existing files modified)
const directionRouter = require('./routes/userDirection.routes');

// ── Daily Engagement System (Step 11)
const {
  engagementRouter,
  startEngagementWorker,
  stopEngagementWorker,
} = require('./modules/daily-engagement');

// Create Express App
const app = express();

// Trust proxy (Cloud Run / Load Balancer safe)
app.set('trust proxy', 1);

// Global Middleware (single registration — duplicates from original removed)
app.use(correlationMiddleware);
app.use(helmet());
app.use(compression());

// CORS — Domain-driven configuration (no hardcoded domains)
// Set MAIN_DOMAIN, ADMIN_DOMAIN, API_DOMAIN in .env
// Admin frontend: https://<ADMIN_DOMAIN>
// Public app:     https://<MAIN_DOMAIN>
// API server:     https://<API_DOMAIN>
const MAIN_DOMAIN  = process.env.MAIN_DOMAIN  || 'hirerise.com';
const ADMIN_DOMAIN = process.env.ADMIN_DOMAIN || `admin.${MAIN_DOMAIN}`;

const allowedOrigins = [
  // Explicit env var overrides (comma-separated)
  ...(process.env.ALLOWED_ORIGINS || 'http://localhost:3001')
    .split(',').map(o => o.trim()),
  // Domain-derived origins (always included in non-test envs)
  ...(process.env.NODE_ENV !== 'test' ? [
    `https://${MAIN_DOMAIN}`,
    `https://${ADMIN_DOMAIN}`,
    `https://www.${MAIN_DOMAIN}`,
  ] : []),
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // HIGH-04 FIX: Wildcard support removed. credentials:true + wildcard is
    // spec-forbidden and a security hole. Origins must be explicitly listed.
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS: Origin ${origin} not allowed`));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'X-Correlation-ID', 'Idempotency-Key'],
  exposedHeaders: ['X-Correlation-ID', 'X-Request-ID'],
  credentials: true,
  maxAge: 86400,
}));

// ── Body Parsing ──────────────────────────────────────────────────────────────
// IMPORTANT: Stripe webhook route must receive raw Buffer for signature
// verification — must be registered BEFORE express.json() processes the body.
app.use('/api/v1/webhooks/stripe', express.raw({ type: 'application/json' })); // ← NEW

app.use(express.json({ limit: '512kb' }));
app.use(express.urlencoded({ extended: true, limit: '512kb' }));

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan(
    process.env.NODE_ENV === 'production' ? 'combined' : 'dev',
    { stream: { write: msg => logger.http(msg.trim()) } }
  ));
}

// API Prefix — must be declared before any route registration
// ARC FIX: hardcoded — never allow env variable override.
const API_PREFIX = '/api/v1';

// Dev Routes — non-production only
if (process.env.NODE_ENV !== 'production') {
  app.use(`${API_PREFIX}/dev`, devRoutes);
}
// Global Rate Limiter
const globalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
  max:      parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '400', 10),
  standardHeaders: true,
  legacyHeaders:   false,
  // HIGH-03 FIX: Rate limit authenticated users by UID, not IP.
  // IP-only limiting is trivially bypassed behind a CDN and unfair in NAT environments.
  // Falls back to IP for unauthenticated requests (webhooks, health).
  keyGenerator: (req) => req.user?.uid || req.ip,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests. Please retry later.' } },
});
app.use(globalLimiter);

/**
 * ✅ Health Check (PUBLIC)
 * Now correctly under /api/v1/health
 */
// Phase 4: Deep health probes (Firestore, Redis, Anthropic, queue depth).
// GET /health        — public, load balancer probe (unchanged behaviour)
// GET /health/deep   — internal ops probe (requires X-Health-Probe-Token header)
app.use(`${API_PREFIX}/health`, require('./routes/health.routes'));

/**
 * ✅ Internal Routes (NO auth token — protected by INTERNAL_SERVICE_TOKEN)
 * Called by Google Cloud Tasks (server-to-server), not by users.
 * Must be registered BEFORE the authenticate middleware block.
 */
const { requireInternalToken } = require('./middleware/internalToken.middleware');
app.use(
  `${API_PREFIX}/internal/provisional-chi`,
  requireInternalToken,
  require('./routes/internal/provisionalChi.route'),
);

// Phase 2: async AI job processor — Cloud Tasks callback
// Receives { jobId } from Cloud Tasks, runs the AI operation, writes result to ai_jobs/{jobId}
app.use(
  `${API_PREFIX}/internal/ai-job`,
  requireInternalToken,
  require('./routes/internal/aiJob.route'),
);

/**
 * ✅ Webhook Routes (NO authenticate — signature-verified by each handler)
 * Must be registered BEFORE protected routes and BEFORE global auth middleware.
 * Razorpay + Stripe send requests from their servers, not from users.
 */
app.use(`${API_PREFIX}/webhooks`, require('./routes/webhooks.routes')); // ← NEW

/**
 * ✅ Protected Route Modules
 * Auth applied per route group (fixes 401-before-404 bug)
 */
app.use(`${API_PREFIX}/career`,        authenticate, require('./routes/career.routes'));
app.use(`${API_PREFIX}/career-graph`,  authenticate, require('./modules/careerGraph/careerGraph.routes'));

/**
 * ✅ Career Path Prediction Engine (standalone)
 *
 * Predicts career progression chains from a user's current role.
 * Uses /data/career-paths.csv as primary source (100+ role progressions).
 * Firestore role_transitions used for enrichment when available.
 * Experience-adjusted timeline: years already served reduce first step.
 *
 * Endpoints:
 *   POST /api/v1/career-path/predict       → Full prediction with timeline
 *   GET  /api/v1/career-path/chain/:role   → Raw CSV progression chain
 *
 * The CHI engine (POST /api/v1/chi-v2/*) also calls this engine internally
 * and appends career_path_prediction to its response.
 */
app.use(`${API_PREFIX}/career-path`, authenticate, require('./routes/career-path.routes'));
app.use(`${API_PREFIX}/career-opportunities`, authenticate, require(`./routes/career-opportunity.routes`));
app.use(`${API_PREFIX}/skill-graph`,   authenticate, require('./modules/skillGraph/skillGraph.routes'));
app.use(`${API_PREFIX}/admin/graph`,             authenticate, requireAdmin, require('./modules/admin/graph/graphAdmin.routes'));
app.use(`${API_PREFIX}/admin/graph-intelligence`, authenticate, requireAdmin, require('./modules/admin/graph/graphIntelligence.routes'));
app.use(`${API_PREFIX}/admin/platform-intelligence`, authenticate, requireAdmin, require('./modules/platform-intelligence/routes/platformIntelligence.routes'));
app.use(`${API_PREFIX}/chi-v2`,                  authenticate, require('./modules/chiV2/chiV2.routes'));
app.use(`${API_PREFIX}/salary`,        authenticate, require('./routes/salary.routes'));
app.use(`${API_PREFIX}/skills`,        authenticate, require('./routes/skills.routes'));

/**
 * ✅ Skill Demand Intelligence Engine (authenticate)
 *
 * Mounted on the same /api/v1/skills prefix as skills.routes above.
 * This is intentional — Express chains both routers sequentially.
 * skills.routes handles CRUD (GET /skills, POST /skills, etc.)
 * skillDemandRouter handles analytics sub-paths (/skills/analyze, /skills/demand/*)
 * No path overlap exists between the two routers.
 *
 * Endpoints:
 *   POST /api/v1/skills/analyze            → Full skill demand analysis (main endpoint)
 *   GET  /api/v1/skills/demand/top         → Top demand skills (filter by industry)
 *   GET  /api/v1/skills/demand/role/:role  → Required skills for a role
 *   GET  /api/v1/skills/demand/history     → User's analysis history
 *
 * Data sources:
 *   /data/skills-demand-india.csv  — skill demand signals
 *   /data/role-skills.csv          — role → required skills mapping
 *
 * CHI Integration:
 *   skill_demand_intelligence is appended to every CHI v2 result
 *   when skill names are provided in the request.
 */
app.use(`${API_PREFIX}/skills`, authenticate, skillDemandRouter);
app.use(`${API_PREFIX}/skills`, authenticate, require('./routes/skills-priority.routes'));
app.use(`${API_PREFIX}/jobs`,          authenticate, require('./routes/jobs.routes'));
app.use(`${API_PREFIX}/resume-growth`, authenticate, require('./routes/resumeGrowth.routes'));
app.use(`${API_PREFIX}/growth`,        authenticate, require('./routes/growth.routes'));
app.use(`${API_PREFIX}/resume-scores`, authenticate, require('./routes/resumeScore.routes'));
app.use(`${API_PREFIX}/learning`,      authenticate, require('./routes/learning.routes'));
app.use(`${API_PREFIX}/resumes`,       authenticate, require('./modules/resume/resume.routes'));
app.use(`${API_PREFIX}/onboarding`,         authenticate, require('./modules/onboarding/onboarding.routes'));
// FIX: onboarding-complete.routes.js was never mounted — GET /onboarding/resume,
// PATCH /onboarding/progress, POST /onboarding/complete all returned 404.
// Without this, onboarding_completed was never saved, AuthGuard kept redirecting
// back to /onboarding in an infinite loop → permanent spinner on /dashboard.
app.use(`${API_PREFIX}/onboarding`,         authenticate, require('./routes/onboarding-complete.routes'));
app.use(`${API_PREFIX}/student-onboarding`, authenticate, require('./routes/student-onboarding.routes'));
app.use(`${API_PREFIX}/career-onboarding`,  authenticate, require('./routes/career-onboarding.routes'));

/**
 * ✅ Job Seeker Intelligence (authenticate)
 *
 * Personalised skill graph + job matching for the professional career path.
 *
 * Endpoints:
 *   GET /api/v1/job-seeker/skills/user-graph     → Personalised skill graph
 *   GET /api/v1/job-seeker/skills/skill-gap      → Skill gap vs market demand
 *   GET /api/v1/job-seeker/jobs/match            → Top matched roles (scored)
 *   GET /api/v1/job-seeker/jobs/recommendations  → Enriched top-5 recommendations
 */
app.use(`${API_PREFIX}/job-seeker`, authenticate, require('./modules/jobSeeker/jobSeeker.routes'));

/**
 * ✅ Semantic AI Upgrade — Skill Intelligence + Job Matching (authenticate)
 *
 * Extends SkillGraphEngine and JobMatchingEngine with vector embedding support.
 * Uses OpenAI text-embedding-3-small + pgvector cosine similarity.
 * Controlled by FEATURE_SEMANTIC_MATCHING=true env flag.
 *
 * Endpoints:
 *   GET  /api/v1/skills/similar                        → semantically similar skills (cosine sim)
 *   POST /api/v1/skills/embed                          → generate/store skill embedding
 *   GET  /api/v1/job-seeker/jobs/semantic-match        → vector-based job matching
 *   GET  /api/v1/career/advice                         → AI career advisor (grounded)
 *   GET  /api/v1/skills/learning-path                  → AI-generated learning paths
 */
app.use(API_PREFIX, authenticate, require('./routes/semantic.routes'));

/**
 * ✅ AI Career Opportunity Radar (authenticate)
 *
 * Detects emerging high-growth roles using labor market signals,
 * skill demand data, and user profile. Personalized match scoring.
 *
 * Endpoints:
 *   GET  /api/v1/career/opportunity-radar              → personalised emerging opportunities
 *   GET  /api/v1/career/emerging-roles                 → public catalogue of emerging roles
 *   POST /api/v1/career/opportunity-radar/refresh      → admin: refresh signals from LMI
 */
app.use(API_PREFIX, authenticate, require('./modules/opportunityRadar/opportunityRadar.routes'));

/**
 * ✅ AI Event Bus — Async Processing Pipeline (authenticate)
 *
 * Enables asynchronous processing of AI engines via BullMQ job queues.
 * Dashboard reads pre-computed results instead of triggering engines directly.
 * Controlled by FEATURE_EVENT_BUS=true env flag.
 *
 * Trigger endpoints (return 202 Accepted + pipelineJobId):
 *   POST /api/v1/career/trigger-analysis               → full pipeline (all 6 workers)
 *   POST /api/v1/career/trigger-job-match              → job matching worker only
 *   POST /api/v1/career/trigger-risk-analysis          → risk analysis worker only
 *   POST /api/v1/career/trigger-opportunity-scan       → opportunity radar worker only
 *   POST /api/v1/career/trigger-advice                 → career advisor worker only
 *   POST /api/v1/career/internal/cv-parsed             → internal: fan out CV_PARSED event
 *
 * Results endpoints (read from Supabase result tables):
 *   GET  /api/v1/career/intelligence-report            → full merged result across all engines
 *   GET  /api/v1/jobs/matches                          → pre-computed job match results
 *   GET  /api/v1/career/risk                           → pre-computed risk analysis results
 *   GET  /api/v1/career/opportunities                  → pre-computed opportunity radar results
 *
 * Polling endpoint:
 *   GET  /api/v1/career/pipeline-status/:jobId         → poll async job status
 */
if (process.env.FEATURE_EVENT_BUS === 'true') {
  app.use(API_PREFIX, authenticate, require('./modules/ai-event-bus/routes/aiEventBus.routes'));
}

/**
 * ✅ AI Personalization Engine (authenticate)
 *
 * Continuously personalizes career recommendations by learning from user
 * behavior signals (clicks, applies, skill views, course views, etc.).
 *
 * Endpoints:
 *   POST /api/v1/user/behavior-event                   → track user interaction
 *   GET  /api/v1/career/personalized-recommendations   → personalized career list
 *   GET  /api/v1/user/personalization-profile          → current signal profile
 *   POST /api/v1/user/update-behavior-profile          → manual profile refresh
 */
app.use(API_PREFIX, authenticate, require('./modules/personalization/personalization.routes'));

/**
 * ✅ Career Copilot — RAG-Grounded Conversational AI (authenticate)
 *
 * Retrieval-Augmented Generation system that grounds every Copilot response
 * in real platform data (CHI, skill gaps, job matches, opportunity radar,
 * risk analysis, salary benchmarks, personalization profile).
 * Includes pre-flight grounding checks and post-flight hallucination scanning.
 *
 * Endpoints:
 *   POST /api/v1/copilot/chat                          → grounded chat response
 *   GET  /api/v1/copilot/welcome                       → data-aware welcome message
 *   GET  /api/v1/copilot/history/:conversationId       → conversation history
 *   GET  /api/v1/copilot/context                       → debug context view (non-prod only)
 */
app.use(`${API_PREFIX}/ava-memory`, authenticate, require('./modules/ava-memory/routes/avaMemory.routes'));
app.use(`${API_PREFIX}/copilot`, authenticate, require('./modules/career-copilot/routes/careerCopilot.routes'));
app.use(`${API_PREFIX}/copilot`, authenticate,
  require('./modules/career-copilot/routes/agentCoordinator.routes'));
app.use(`${API_PREFIX}/education`,          authenticate, require('./modules/education-intelligence/routes/student.routes'));

/**
 * ✅ Education Intelligence — AI Stream Analysis (authenticate)
 *
 * Runs the four-engine pipeline after onboarding completes.
 * Also auto-triggered in the background by saveCognitive() on the final onboarding step.
 *
 * Engines (in order):
 *   1. AcademicTrendEngine     — subject trends + stream subject scores
 *   2. CognitiveProfileEngine  — learning style + stream cognitive affinity
 *   3. ActivityAnalyzerEngine  — extracurricular stream influence signals
 *   4. StreamIntelligenceEngine — weighted combination → final recommendation
 *
 * Endpoints:
 *   POST /api/v1/education/analyze/:studentId  → run pipeline, save + return recommendation
 *   GET  /api/v1/education/analyze/:studentId  → return cached result (no re-run)
 *
 * Auth: students may only access their own profile; admins may access any.
 */
app.use(`${API_PREFIX}/education`,     authenticate, require('./modules/education-intelligence/routes/analysis.routes'));

/**
 * ✅ Education Intelligence — Career Success Probability Engine (authenticate)
 *
 * Runs the Career Success Probability Engine for a student and returns
 * the top 5 ranked careers with probability scores (0–100).
 *
 * Endpoints:
 *   POST /api/v1/education/career-prediction/:studentId  → run CSPE, store + return top_careers
 *   GET  /api/v1/education/career-prediction/:studentId  → return stored predictions
 */
app.use(`${API_PREFIX}/education`,     authenticate, require('./modules/education-intelligence/routes/careerPrediction.routes'));

/**
 * ✅ Education Intelligence — Education ROI Engine (authenticate)
 *
 * Calculates ROI scores for education paths relevant to a student's
 * career predictions. Returns ranked education options with cost,
 * expected salary, and ROI level (Very High / High / Moderate / Low).
 *
 * Endpoints:
 *   POST /api/v1/education/roi-analysis/:studentId  → run ERE, store + return education_options
 *   GET  /api/v1/education/roi-analysis/:studentId  → return stored ROI results
 */
app.use(`${API_PREFIX}/education`,     authenticate, require('./modules/education-intelligence/routes/roiAnalysis.routes'));

/**
 * ✅ Education Intelligence — Career Digital Twin Engine (authenticate)
 *
 * Simulates a 10-year salary trajectory for each top career using
 * cognitive profile, learning velocity, demand signals, and ROI data.
 *
 * Endpoints:
 *   POST /api/v1/education/career-simulation/:studentId  → run CDTE, store + return simulations
 *   GET  /api/v1/education/career-simulation/:studentId  → return stored simulations
 */
app.use(`${API_PREFIX}/education`,     authenticate, require('./modules/education-intelligence/routes/careerSimulation.routes'));

/**
 * ✅ Skill Evolution Engine (SEE) (authenticate)
 *
 * Returns ranked skill recommendations + learning roadmap for a student,
 * generated by the SEE pipeline step in the education orchestrator.
 *
 * Endpoints:
 *   GET /api/v1/education/skills/recommendations/:studentId  → ranked skills + roadmap
 *   GET /api/v1/education/skills/student-skills/:studentId   → raw per-skill rows
 */
app.use(`${API_PREFIX}/education/skills`, authenticate, require('./modules/skill-evolution/routes/skill.routes'));

/**
 * Provides live career demand scores, skill trends, and salary benchmarks
 * derived from aggregated job posting analysis. Used by the dashboard
 * and injected into the ROI + Digital Twin engines via the orchestrator.
 *
 * Endpoints:
 *   GET  /api/v1/market/career-trends      → demand + trend scores per career
 *   GET  /api/v1/market/skill-demand       → top trending skills (optional ?limit=N)
 *   GET  /api/v1/market/salary-benchmarks  → avg entry / 5-yr / 10-yr salaries per career
 *   POST /api/v1/market/refresh            → trigger full LMI refresh (admin only)
 *   POST /api/v1/market/ingest             → trigger job collection only (admin only)
 */
app.use(`${API_PREFIX}/market`,        authenticate, require('./modules/labor-market-intelligence/routes/market.routes'));

/**
 * ✅ Global Career Intelligence Dashboard (GCID) (authenticate)
 *
 * Macro-level career intelligence aggregated from LMI, Skill Evolution Engine,
 * Education ROI data, Career Graph, and student outcomes.
 *
 * Endpoints:
 *   GET /api/v1/analytics/career-demand      → Career Demand Index (ranked)
 *   GET /api/v1/analytics/skill-demand       → Skill Demand Index  (ranked)
 *   GET /api/v1/analytics/education-roi      → Education ROI Index (ranked)
 *   GET /api/v1/analytics/career-growth      → 10-year salary forecast per career
 *   GET /api/v1/analytics/industry-trends    → Emerging sector analysis
 *   GET /api/v1/analytics/overview           → All five in one response
 *   GET /api/v1/analytics/snapshots/:metric  → Historical snapshots
 */
app.use(`${API_PREFIX}/analytics`,     authenticate, require('./modules/career-intelligence-dashboard/routes/analytics.routes'));

app.use(`${API_PREFIX}/career-health`, authenticate, require('./modules/careerHealthIndex/careerHealthIndex.routes'));

/**
 * ✅ AI Career Advisor (authenticate)
 *
 * Conversational AI career guidance using Claude (Sonnet).
 * Grounds every response in the student's own analysis data
 * (stream scores, cognitive profile, career predictions, ROI, market signals).
 *
 *   POST /api/v1/advisor/chat/:studentId     → AI response to student question
 *   GET  /api/v1/advisor/welcome/:studentId  → personalised welcome message
 *   GET  /api/v1/advisor/history/:studentId  → conversation history
 */
app.use(`${API_PREFIX}/advisor`, authenticate, require('./modules/ai-career-advisor/routes/advisor.routes'));

/**
 * ✅ School & Counselor Platform (authenticate)
 *
 * Multi-tenant school management, bulk student import, analytics,
 * and AI assessment triggering for school admins and counselors.
 *
 *   POST /api/v1/school                                     → create school
 *   GET  /api/v1/school/my                                  → schools I belong to
 *   GET  /api/v1/school/:schoolId                           → school detail
 *   POST /api/v1/school/:schoolId/counselors                → add counselor (admin)
 *   GET  /api/v1/school/:schoolId/students                  → list students
 *   POST /api/v1/school/:schoolId/students/import           → bulk CSV import (admin)
 *   POST /api/v1/school/:schoolId/run-assessment/:studentId → trigger AI pipeline
 *   GET  /api/v1/school/:schoolId/student-report/:studentId → full student report
 *   GET  /api/v1/school/:schoolId/analytics                 → school analytics
 */
app.use(`${API_PREFIX}/school`, authenticate, require('./modules/school/routes/school.routes'));

/**
 * ✅ University Integration Platform (authenticate)
 *
 * Allows universities to register, manage academic programs, and view
 * aggregated student match insights. No student PII is exposed — all
 * student-facing data returned is aggregated counts, stream distributions,
 * and skill frequencies only.
 *
 * Role model (university-scoped, enforced by university.middleware.js):
 *   university_admin  — full access: CRUD programs + analytics
 *   university_staff  — read-only: programs + analytics
 *
 * Firestore collections: uni_universities, uni_university_users, uni_programs
 *
 *   POST   /api/v1/university                                        → register university (any authed user)
 *   GET    /api/v1/university/my                                     → universities I belong to
 *   GET    /api/v1/university/:universityId                          → university detail (member)
 *   POST   /api/v1/university/:universityId/programs                 → add program (admin)
 *   GET    /api/v1/university/:universityId/programs                 → list programs (member)
 *   PATCH  /api/v1/university/:universityId/programs/:programId      → update program (admin)
 *   DELETE /api/v1/university/:universityId/programs/:programId      → delete program (admin)
 *   GET    /api/v1/university/:universityId/analytics                → dashboard analytics (member)
 *   GET    /api/v1/university/:universityId/programs/:programId/matches → aggregated student signals (member)
 */
app.use(`${API_PREFIX}/university`, authenticate, require('./modules/university/routes/university.routes'));

/**
 * ✅ Employer Integration Platform (authenticate)
 *
 * Allows employers to register, manage job roles, and view anonymised
 * talent pipeline analytics. Employers NEVER receive personally identifiable
 * student data — only aggregated skill coverage, stream distribution, and
 * pipeline counts are returned.
 *
 * Role model (employer-scoped, enforced by employer.middleware.js):
 *   employer_admin  — full access: CRUD job roles + pipeline analytics
 *   employer_hr     — read-only: job roles + pipeline analytics
 *
 * Firestore collections: emp_employers, emp_employer_users, emp_job_roles
 *
 *   POST   /api/v1/employer                                          → register employer org (any authed user)
 *   GET    /api/v1/employer/my                                       → employer orgs I belong to
 *   GET    /api/v1/employer/:employerId                              → employer detail (member)
 *   POST   /api/v1/employer/:employerId/roles                        → add job role (admin)
 *   GET    /api/v1/employer/:employerId/roles                        → list job roles (member)
 *   PATCH  /api/v1/employer/:employerId/roles/:roleId                → update role (admin)
 *   DELETE /api/v1/employer/:employerId/roles/:roleId                → deactivate role (admin)
 *   GET    /api/v1/employer/:employerId/talent-pipeline              → full pipeline analytics (member)
 *   GET    /api/v1/employer/:employerId/roles/:roleId/matches        → per-role talent signals (member)
 */
app.use(`${API_PREFIX}/employer`, authenticate, require('./modules/employer/routes/employer.routes'));

/**
 * ✅ Student Opportunities — AI Matching Engine (authenticate)
 *
 * Returns personalised university program and job role matches for a student,
 * scored by the studentMatching.service.js engine using:
 *   - Stream recommendation      (edu_stream_scores)
 *   - Career predictions          (edu_career_predictions)
 *   - Self-reported skills        (edu_students)
 *   - Cognitive profile           (edu_cognitive_results)
 *   - Market demand signals       (Labor Market Intelligence Layer)
 *
 * Authorization:
 *   - Students may only fetch their own opportunities (UID === studentId)
 *   - Admins may fetch any student's opportunities
 *
 * Matching score weights:
 *   University programs:  stream_alignment 40% + career_alignment 35% + skill_match 25%
 *   Job roles:            skill_match 40% + stream_alignment 30% + career_alignment 30%
 *
 *   GET /api/v1/opportunities/:studentId
 *   Response: { student_id, universities: [...], jobs: [...] }
 */
app.use(`${API_PREFIX}/opportunities`, authenticate, require('./modules/opportunities/routes/opportunities.routes'));

// Phase 3: user activity tracking — streak, weekly summary, chi delta
app.use(`${API_PREFIX}/user-activity`, require('./modules/userActivity/userActivity.routes'));
app.use(`${API_PREFIX}/job-analyses`,  authenticate, require('./routes/jobAnalyzer.routes'));
app.use(`${API_PREFIX}/cv-builder`,    authenticate, require('./routes/cvBuilder.routes'));
app.use(`${API_PREFIX}/users`,         authenticate, require('./routes/users.routes'));

/**
 * ✅ Intent Gateway — Direction Preference (authenticate)
 *
 * Saves, reads, and resets the user's chosen focus direction.
 * Called by the Intent Gateway page shown once after first login.
 * Does NOT modify users.routes.js or any existing user logic.
 *
 * Endpoints:
 *   POST   /api/v1/users/me/direction  → save direction ('education' | 'career' | 'market')
 *   GET    /api/v1/users/me/direction  → read current direction (null if not set)
 *   DELETE /api/v1/users/me/direction  → reset direction (gateway shown again on next login)
 */
app.use(`${API_PREFIX}/users`,         authenticate, directionRouter);
app.use(`${API_PREFIX}/analyze`,       authenticate, require('./modules/analysis/analysis.route'));
// Phase 2: async AI job status poll — GET /api/v1/ai-jobs/:jobId
app.use(`${API_PREFIX}/ai-jobs`,       authenticate, require('./routes/aiJobs.route'));
app.use(`${API_PREFIX}/roles`,         authenticate, require('./modules/roles/roles.routes'));
app.use(`${API_PREFIX}/applications`,  authenticate, require('./jobApplications/jobApplications.routes'));
app.use(`${API_PREFIX}/cover-letter`,  authenticate, require('./modules/coverLetter/coverLetter.routes'));
app.use(`${API_PREFIX}/dashboard`,     authenticate, require('./modules/dashboard/dashboard.route'));
app.use(`${API_PREFIX}/app-entry`,     authenticate, require('./modules/appEntry/appEntry.route'));
app.use(`${API_PREFIX}/qualifications`, authenticate, require('./modules/qualification/qualification.routes'));

/**
 * ✅ Admin Routes (authenticate + requireAdmin)
 * requireAdmin checks decoded.admin === true OR decoded.role === 'admin'|'super_admin'
 * Requires custom claim to be set on the Firebase user:
 *   await getAuth().setCustomUserClaims(uid, { admin: true, role: 'admin' });
 *
 * Rate limit: 50 req/min per user (adminRateLimit)
 */
app.use(`${API_PREFIX}/admin`, adminRateLimit);
app.use(`${API_PREFIX}/admin/metrics`,           authenticate, requireAdmin, require('./routes/admin/adminMetrics.routes'));  // ← NEW
app.use(`${API_PREFIX}/admin/ai`,               authenticate, requireAdmin, require('./routes/admin/ai-observability.routes')); // ← NEW (was unguarded)
app.use(`${API_PREFIX}/admin/jobs`,             authenticate, requireAdmin, require('./modules/admin/jobs/adminJobs.routes')); // ← DEAD-01
app.use(`${API_PREFIX}/admin/adaptive-weights`, authenticate, requireAdmin, require('./modules/adaptiveWeight/adaptiveWeight.routes')); // ← DEAD-03
// C-02 FIX: career-readiness is marked DEAD-02. Gated behind feature flag.
// To re-enable: set FEATURE_CAREER_READINESS=true in your .env
// To remove permanently: delete this block + src/modules/career-readiness/
if (process.env.FEATURE_CAREER_READINESS === 'true') {
  app.use(`${API_PREFIX}/career-readiness`, authenticate, require('./modules/career-readiness/careerReadiness.routes'));
}

/**
 * ✅ Admin CMS Dataset Ingestion (authenticate + requireAdmin)
 *
 * Duplicate prevention enforced at two layers:
 *   1. Service layer — normalized name lookup before every insert
 *   2. Firestore index — composite index on normalizedName / normalizedCompositeKey
 *
 * Security contract:
 *   - Admin identity (createdByAdminId) always sourced from req.user.uid (JWT)
 *   - No admin identity is accepted from any request body — blocked by validators
 *   - All routes inherit authenticate + requireAdmin from this mount point
 *
 * Endpoints registered:
 *   POST   /api/v1/admin/cms/skills                → Create skill (dedup check)
 *   PATCH  /api/v1/admin/cms/skills/:skillId       → Update skill (re-checks on rename)
 *   GET    /api/v1/admin/cms/skills                → List skills
 *
 *   POST   /api/v1/admin/cms/roles                 → Create role (composite key dedup)
 *   PATCH  /api/v1/admin/cms/roles/:roleId         → Update role
 *   GET    /api/v1/admin/cms/roles                 → List roles
 *
 *   POST   /api/v1/admin/cms/job-families          → Create job family (dedup)
 *   PATCH  /api/v1/admin/cms/job-families/:id      → Update
 *   GET    /api/v1/admin/cms/job-families          → List
 *
 *   POST   /api/v1/admin/cms/education-levels      → Create education level (dedup)
 *   PATCH  /api/v1/admin/cms/education-levels/:id  → Update
 *   GET    /api/v1/admin/cms/education-levels      → List
 *
 *   POST   /api/v1/admin/cms/salary-benchmarks     → Create salary benchmark (dedup)
 *   PATCH  /api/v1/admin/cms/salary-benchmarks/:id → Update
 *   GET    /api/v1/admin/cms/salary-benchmarks     → List
 *
 *   POST   /api/v1/admin/cms/import                → Bulk CSV import with full dedup pipeline
 *                                                    Returns HTTP 207 on partial success
 */
app.use(
  `${API_PREFIX}/admin/cms/skills`,
  authenticate, requireAdmin,
  require('./modules/admin/cms/skills/adminCmsSkills.routes')
);

app.use(
  `${API_PREFIX}/admin/cms/roles`,
  authenticate, requireAdmin,
  require('./modules/admin/cms/roles/adminCmsRoles.routes')
);

// Generic CMS modules (jobFamilies, educationLevels, salaryBenchmarks) are
// produced by the factory and expose a pre-built Express router.
const {
  jobFamiliesModule,
  educationLevelsModule,
  salaryBenchmarksModule,
} = require('./modules/admin/cms/adminCmsGeneric.factory');

// Taxonomy extension modules
const careerDomainsModule = require('./modules/admin/cms/career-domains/adminCmsCareerDomains.module');
const skillClustersModule = require('./modules/admin/cms/skill-clusters/adminCmsSkillClusters.module');

app.use(
  `${API_PREFIX}/admin/cms/career-domains`,
  authenticate, requireAdmin,
  careerDomainsModule.router
);

app.use(
  `${API_PREFIX}/admin/cms/skill-clusters`,
  authenticate, requireAdmin,
  skillClustersModule.router
);

app.use(
  `${API_PREFIX}/admin/cms/job-families`,
  authenticate, requireAdmin,
  jobFamiliesModule.router
);

app.use(
  `${API_PREFIX}/admin/cms/education-levels`,
  authenticate, requireAdmin,
  educationLevelsModule.router
);

app.use(
  `${API_PREFIX}/admin/cms/salary-benchmarks`,
  authenticate, requireAdmin,
  salaryBenchmarksModule.router
);

app.use(
  `${API_PREFIX}/admin/cms/import`,
  authenticate, requireAdmin,
  require('./modules/admin/cms/import/adminCmsImport.routes')
);

/**
 * ✅ Admin CMS CSV File Upload Import (authenticate + requireAdmin)
 *
 * Accepts multipart/form-data CSV uploads and pipes them through the
 * existing duplicate-prevention pipeline (adminCmsImport.service).
 *
 * POST /api/v1/admin/cms/import/csv/:datasetType
 *
 * Supported datasetType values:
 *   skills | roles | jobFamilies | educationLevels
 *
 * To add new types later (courses, universities, etc.):
 *   1. Add type to SUPPORTED_TYPES in adminCmsImport.service.js
 *   2. Add repository lazy-loader in adminCmsImport.service.js
 *   3. No changes needed here
 */
app.use(
  `${API_PREFIX}/admin/cms/import/csv`,
  authenticate, requireAdmin,
  require('./modules/admin/import/import.routes')
);

/**
 * ✅ Contributor Submission + Approval Workflow
 *
 * Two-tier admin system:
 *   contributor  → can submit entries for review
 *   admin+       → can approve/reject, writes approved entries to live collections
 *
 * Endpoints:
 *   POST   /api/v1/admin/pending                   → contributor submits entry
 *   GET    /api/v1/admin/pending                   → list (admin: all, contributor: own)
 *   GET    /api/v1/admin/pending/:id               → single entry
 *   POST   /api/v1/admin/pending/:id/approve       → admin approves → writes to live collection
 *   POST   /api/v1/admin/pending/:id/reject        → admin rejects with reason
 *   DELETE /api/v1/admin/pending/:id               → contributor withdraws own submission
 */
app.use(
  `${API_PREFIX}/admin/pending`,
  authenticate, requireContributor,
  require('./routes/admin/adminPending.routes')
);

/**
 * ✅ Contributor Management (authenticate + requireAdmin)
 *
 * Master admin promotes/demotes users to the contributor role.
 *
 * Endpoints:
 *   GET  /api/v1/admin/contributors          → list all contributors
 *   POST /api/v1/admin/contributors/promote  → grant contributor role (sets Firebase custom claim)
 *   POST /api/v1/admin/contributors/demote   → revoke contributor role
 */
app.use(
  `${API_PREFIX}/admin/contributors`,
  authenticate, requireAdmin,
  require('./routes/admin/adminContributors.routes')
);

/**
 * ✅ Salary Data API (authenticate — granular admin guard inside route)
 *
 * Endpoints:
 *   GET  /api/v1/salary-data/:roleId            → aggregated salary intelligence (any authed user)
 *   GET  /api/v1/salary-data/:roleId/records    → raw salary records (admin only, guarded in route)
 *   POST /api/v1/salary-data                    → manual admin salary entry (admin only, guarded in route)
 *
 * Optional query filters: ?location=India&experienceLevel=Mid&industry=Technology
 */
app.use(
  `${API_PREFIX}/salary-data`,
  authenticate,
  require('./modules/salary/salary.routes')
);

/**
 * ✅ Admin Entity CSV Import (authenticate + requireAdmin)
 *
 * Serves the Bulk Data Import UI in the admin dashboard.
 * Accepts multipart/form-data CSV uploads — one route per entity type,
 * matching the frontend's ImportEntity values exactly.
 *
 * Endpoints:
 *   POST /api/v1/admin/import/skills
 *   POST /api/v1/admin/import/roles
 *   POST /api/v1/admin/import/job-families
 *   POST /api/v1/admin/import/education-levels
 *   POST /api/v1/admin/import/salary-benchmarks
 *
 * Body: multipart/form-data — field "file" (CSV, max 10 MB)
 * Response: { success, created, updated, skipped, failed, total, rows[], importedAt }
 *
 * To add a new entity type:
 *   1. Add a config entry to ENTITY_CONFIG in adminImport.service.js
 *   2. Add the route in adminImport.routes.js
 *   3. No changes needed here
 */
app.use(
  `${API_PREFIX}/admin/import`,
  authenticate, requireAdmin,
  require('./modules/admin/import/adminImport.routes')
);

/**
 * ✅ CSV Salary Bulk Import (authenticate + requireAdmin)
 *
 * Endpoint:
 *   POST /api/v1/admin/import/salaries
 *   Content-Type: multipart/form-data, field: file (CSV, max 10MB)
 *
 * Flow: multer → streaming csv-parser → role normalization → validate → batch Firestore write
 * Returns HTTP 207 on partial success (some rows skipped/errored).
 */
app.use(
  `${API_PREFIX}/admin/import/salaries`,
  authenticate, requireAdmin,
  require('./modules/salaryImport/salaryImport.routes')
);

/**
 * ✅ Role Alias Management (authenticate + requireAdmin)
 *
 * Endpoints:
 *   POST /api/v1/admin/cms/role-aliases          → create alias (e.g. "Backend Dev" → "Software Engineer")
 *   GET  /api/v1/admin/cms/role-aliases/:roleId  → list aliases for a role
 *
 * Used by CSV import + sync worker to normalize role names from external sources.
 */
app.use(
  `${API_PREFIX}/admin/cms/role-aliases`,
  authenticate, requireAdmin,
  require('./modules/roleAliases/roleAlias.routes')
);

/**
 * ✅ External API Registry (authenticate + requireMasterAdmin)
 * MASTER_ADMIN only — regular admins receive HTTP 403.
 * Rate limit: 30 req/min per user (masterRateLimit)
 *
 * Endpoints:
 *   POST   /api/v1/master/apis       → register new external salary API (PayScale, Glassdoor, BLS…)
 *   GET    /api/v1/master/apis       → list all registered APIs (apiKey redacted in response)
 *   PATCH  /api/v1/master/apis/:id   → update config (apiKey, baseUrl, rateLimit, enabled)
 *   DELETE /api/v1/master/apis/:id   → soft-delete API config
 *
 * Grant MASTER_ADMIN: node src/scripts/setMasterAdmin.js <uid>
 */
app.use(
  `${API_PREFIX}/master/apis`,
  masterRateLimit,
  authenticate, requireMasterAdmin,
  require('./modules/master/master.routes')
);

/**
 * ✅ Salary Sync Control (authenticate + requireMasterAdmin)
 * MASTER_ADMIN only.
 *
 * Endpoints:
 *   POST /api/v1/master/sync/trigger  → manually trigger salary API sync (runs in background, returns 202)
 *   GET  /api/v1/master/sync/status   → last sync timestamp per provider
 *
 * Automated sync also runs daily at 02:00 UTC via salaryApiSync.worker.js
 * Start worker: npm run worker:salary-sync
 */
app.use(
  `${API_PREFIX}/master/sync`,
  masterRateLimit,
  authenticate, requireMasterAdmin,
  require('./modules/master/masterSync.routes')
);

/**
 * ✅ Secrets Manager (authenticate + requireMasterAdmin ONLY)
 *
 * Stores and manages AES-256-GCM encrypted API keys and credentials.
 * Accessible exclusively to users with role === 'MASTER_ADMIN'.
 *
 * Security guarantees:
 *   - Secrets encrypted with AES-256-GCM (unique IV per secret) before Firestore storage
 *   - HMAC-SHA256 tamper seal bound to secret name (prevents ciphertext substitution)
 *   - No API endpoint ever returns a decrypted value — masked previews only
 *   - Mutation endpoints rate-limited to 10 requests/hour/admin UID
 *   - Every create/update/delete emits an audit log entry to admin_logs
 *
 * Endpoints:
 *   POST   /api/v1/admin/secrets              → Create or update a secret (write-only value)
 *   GET    /api/v1/admin/secrets              → List secrets (metadata + masked preview only)
 *   GET    /api/v1/admin/secrets/:name/status → Masked preview for a specific secret
 *   DELETE /api/v1/admin/secrets/:name        → Permanently delete a secret
 *
 * Runtime usage in backend services:
 *   const { getSecret } = require('./modules/secrets');
 *   const apiKey = await getSecret('ANTHROPIC_API_KEY');
 */
app.use(
  `${API_PREFIX}/admin/secrets`,
  authenticate, requireMasterAdmin,
  secretsRouter
);

/**
 * ✅ Market Intelligence API Configuration (authenticate + requireMasterAdmin ONLY)
 *
 * Endpoints for securely configuring and testing external labor market APIs.
 * All credentials are stored in Secret Manager — never in Firestore.
 *
 *   POST   /api/v1/admin/market-intelligence/config        → Save API credentials
 *   POST   /api/v1/admin/market-intelligence/test          → Test API connection
 *   GET    /api/v1/admin/market-intelligence/status        → Get provider + sync status
 *   GET    /api/v1/admin/market-intelligence/data-sources  → Dashboard data source list
 *   POST   /api/v1/admin/market-intelligence/fetch         → Manually trigger data fetch
 */
app.use(
  `${API_PREFIX}/admin/market-intelligence`,
  authenticate, requireMasterAdmin,
  marketIntelRouter
);

// Phase 3: Prometheus /metrics endpoint — only active when OBSERVABILITY_BACKEND=prometheus
// Safe no-op in all other modes (noop/otel). Mount before 404 handler.
const observabilityAdapter = require('./adapters/observability-adapter');
app.get(`${API_PREFIX}/metrics`, observabilityAdapter.prometheusMetricsHandler());

/**
 * ✅ Daily Engagement System (Step 11) — Insights, Progress, Alerts (authenticate)
 *
 * Personalised daily engagement layer driven by BullMQ async workers.
 *
 * MODULE 1 — Daily Career Insights
 *   GET  /api/v1/career/daily-insights              → personalised insight feed (cached 10 min)
 *   POST /api/v1/career/daily-insights/read         → mark insights as read
 *   POST /api/v1/career/daily-insights/generate     → trigger fresh generation
 *
 * MODULE 2 — Career Progress Tracker
 *   GET  /api/v1/career/progress                    → career progress report + chart data
 *   POST /api/v1/career/progress/record             → manual progress snapshot
 *
 * MODULE 3 — Career Opportunity Alerts
 *   GET  /api/v1/career/alerts                      → opportunity alert feed (cached 10 min)
 *   POST /api/v1/career/alerts/read                 → mark alerts as read
 */
app.use(`${API_PREFIX}/career`, authenticate, engagementRouter);

/**
 * Career Digital Twin — simulation engine
 *   POST /api/v1/career/simulations          → run simulation
 *   GET  /api/v1/career/simulations          → simulation history
 *   GET  /api/v1/career/future-paths         → quick path preview
 *   DELETE /api/v1/career/simulations/cache  → bust Redis cache
 */
app.use(`${API_PREFIX}/career`, authenticate, require('./modules/career-digital-twin/routes/digitalTwin.routes'));

/**
 * 404 + Error Handlers
 */
app.use(notFoundHandler);
app.use(errorHandler);

// B-05 FIX: Gotenberg health check on startup.
// If GOTENBERG_URL is set (production), verify it is reachable before accepting traffic.
// Fails fast at boot rather than at the first PDF generation request.
// Puppeteer is the local-dev fallback when GOTENBERG_URL is absent.
if (process.env.GOTENBERG_URL && process.env.NODE_ENV !== 'test') {
  (async () => {
    try {
      const res = await fetch(`${process.env.GOTENBERG_URL}/health`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      logger.info('[Server] Gotenberg health check passed', { url: process.env.GOTENBERG_URL });
    } catch (err) {
      logger.error('[Server] WARNING: Gotenberg unreachable — PDF generation will fail', {
        url: process.env.GOTENBERG_URL, error: err.message,
      });
    }
  })();
}

// ── AI Event Bus Workers ──────────────────────────────────────────────────────
// Start BullMQ workers when event bus is enabled.
// Workers process AI engine jobs asynchronously (SkillGraph, CareerHealth,
// JobMatching, RiskAnalysis, OpportunityRadar, CareerAdvisor, Personalization).
if (process.env.FEATURE_EVENT_BUS === 'true') {
  try {
    const { startAll, stopAll } = require('./modules/ai-event-bus/workers');
    startAll();
    logger.info('[Server] AI Event Bus workers started');

    process.on('SIGTERM', async () => {
      logger.info('[Server] Stopping AI Event Bus workers...');
      await stopAll().catch(() => {});
      const { closeAllQueues } = require('./modules/ai-event-bus/bus/aiEventBus');
      await closeAllQueues().catch(() => {});
    });
  } catch (err) {
    logger.warn('[Server] AI Event Bus workers failed to start (non-fatal)', { err: err.message });
  }
}

// ── AI Personalization Worker ─────────────────────────────────────────────────
// Processes async behavior profile updates and recommendation pre-computation.
if (process.env.FEATURE_PERSONALIZATION === 'true') {
  try {
    const {
      personalizationWorkerInstance,
      startPersonalizationHook,
    } = require('./modules/personalization/personalizationWorker');
    personalizationWorkerInstance.start();
    startPersonalizationHook();
    logger.info('[Server] Personalization worker started');

    process.on('SIGTERM', async () => {
      await personalizationWorkerInstance.stop().catch(() => {});
    });
  } catch (err) {
    logger.warn('[Server] Personalization worker failed to start (non-fatal)', { err: err.message });
  }
}

// ── Daily Engagement Worker (Step 11) ─────────────────────────────────────────
// Processes async engagement events (insight generation, progress snapshots,
// opportunity alerts). Set RUN_ENGAGEMENT_WORKER=true to run inline with the
// server; leave false (default) to run as a separate process via
// `npm run worker:engagement`.
if (process.env.RUN_ENGAGEMENT_WORKER === 'true') {
  try {
    startEngagementWorker();
    logger.info('[Server] Daily engagement worker started');

    process.on('SIGTERM', async () => {
      await stopEngagementWorker().catch(() => {});
    });
  } catch (err) {
    logger.warn('[Server] Daily engagement worker failed to start (non-fatal)', { err: err.message });
  }
}

const PORT = parseInt(process.env.PORT || '3000', 10);
let server;

if (process.env.NODE_ENV !== 'test') {
  server = app.listen(PORT, () => {
    logger.info(`[Server] HireRise Core running on port ${PORT} [${process.env.NODE_ENV}]`);
    logger.info(`[Server] API Base: ${API_PREFIX}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`[Server] Port ${PORT} is already in use.`);
    } else {
      logger.error('[Server] Startup error:', err);
    }
  });

  const gracefulShutdown = (signal) => {
    logger.info(`[Server] ${signal} received — shutting down gracefully...`);
    if (server) server.close(() => logger.info('[Server] HTTP server closed.'));
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.error('[Server] Unhandled Promise Rejection:', reason));
  process.on('uncaughtException',  (err)    => logger.error('[Server] Uncaught Exception:', err));
}

module.exports = app;








