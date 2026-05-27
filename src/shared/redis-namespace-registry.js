'use strict';

/**
 * core/src/shared/redis-namespace-registry.js
 *
 * Authoritative registry of every Redis key namespace used in core/.
 *
 * GOVERNANCE: Doc 06 — Cache Governance
 *
 * RULES:
 *   1. Every namespace written to Redis must be declared here before use.
 *   2. Each entry must declare: prefix, owner, ttl, purpose.
 *   3. ttl: 0 requires a ttlJustification field.
 *   4. No two prefixes may overlap (neither may be a prefix of the other).
 *   5. AI module namespaces must use the 'ai:' first segment.
 *   6. Deprecated entries add deprecated: true and deprecatedAt before removal.
 *
 * ADDING A NAMESPACE:
 *   Add an entry, open a PR. CODEOWNERS will require architecture review.
 *   Verify no prefix collides with an existing entry before merging.
 *
 * FIELDS:
 *   prefix           {string}  Redis key prefix including trailing colon
 *   owner            {string}  Path relative to core/src/ — the one service
 *                              with write authority for this namespace
 *   ttl              {number}  Default TTL in seconds. 0 = no expiry.
 *   ttlJustification {string}  Required when ttl === 0
 *   purpose          {string}  One sentence describing what is cached
 */

module.exports = {
  namespaces: [

    // ── Dashboard ─────────────────────────────────────────────────────────────
    {
      prefix:  'dashboard:snap:',
      owner:   'modules/dashboard/dashboard.service.js',
      ttl:     300,
      purpose: 'Full dashboard snapshot per user, keyed by userId.',
    },
    {
      prefix:  'dashboard:intelligence-report:',
      owner:   'modules/dashboard/dashboard.service.js',
      ttl:     600,
      purpose: 'AI-enriched intelligence report section of the dashboard per user.',
    },
    {
      prefix:  'dashboard:job-matches:',
      owner:   'modules/dashboard/dashboard.service.js',
      ttl:     600,
      purpose: 'Job match results surfaced on the dashboard per user.',
    },
    {
      prefix:  'dashboard:opportunities:',
      owner:   'modules/dashboard/dashboard.service.js',
      ttl:     600,
      purpose: 'Opportunity radar results surfaced on the dashboard per user.',
    },
    {
      prefix:  'dashboard:risk-analysis:',
      owner:   'modules/dashboard/dashboard.service.js',
      ttl:     600,
      purpose: 'Career risk analysis surfaced on the dashboard per user.',
    },
    {
      prefix:  'dashboard-summary:',
      owner:   'modules/dashboard/dashboard.service.js',
      ttl:     300,
      purpose: 'Lightweight dashboard summary by time-range (days).',
    },

    // ── Career graph ──────────────────────────────────────────────────────────
    {
      prefix:  'cg:role:',
      owner:   'modules/careerGraph/careerGraph.service.js',
      ttl:     86400,
      purpose: 'Role node data keyed by normalized role ID. Slow-changing; daily TTL.',
    },
    {
      prefix:  'cg:salary:',
      owner:   'modules/careerGraph/careerGraph.service.js',
      ttl:     86400,
      purpose: 'Salary benchmark keyed by role + country + experience bucket.',
    },
    {
      prefix:  'cg:skills:',
      owner:   'modules/careerGraph/careerGraph.service.js',
      ttl:     86400,
      purpose: 'Skills graph for a role, keyed by normalized role ID.',
    },
    {
      prefix:  'graph:career',
      owner:   'modules/careerGraph/careerGraph.service.js',
      ttl:     3600,
      purpose: 'Aggregate career progression graph (non-user-specific).',
    },
    {
      prefix:  'graph:skills',
      owner:   'modules/careerGraph/careerGraph.service.js',
      ttl:     3600,
      purpose: 'Aggregate skills graph (non-user-specific).',
    },

    // ── App entry ─────────────────────────────────────────────────────────────
    {
      prefix:           'app-entry:',
      owner:            'modules/appEntry/appEntry.service.js',
      ttl:              0,
      ttlJustification: 'App-entry state changes only on explicit user events (step completion, resume upload). TTL-based expiry would cause the gate to oscillate. Invalidation is explicit.',
      purpose:          'Onboarding completion gate state per user.',
    },

    // ── Skills ────────────────────────────────────────────────────────────────
    {
      prefix:  'skill-priority:user:',
      owner:   'modules/adaptiveWeight/adaptiveWeight.service.js',
      ttl:     1800,
      purpose: 'Adaptive weight engine output (priority-ranked skills) per user.',
    },
    {
      prefix:  'skill-gap:user:',
      owner:   'modules/adaptiveWeight/adaptiveWeight.service.js',
      ttl:     1800,
      purpose: 'Computed skill gap per user.',
    },
    {
      prefix:  'skill-graph:user:',
      owner:   'modules/adaptiveWeight/adaptiveWeight.service.js',
      ttl:     1800,
      purpose: 'User-specific skill graph snapshot.',
    },
    {
      prefix:  'radar:skills:',
      owner:   'modules/career-readiness/deterministic.engine.js',
      ttl:     900,
      purpose: 'Skills radar data used by the career readiness engine.',
    },

    // ── Resume ────────────────────────────────────────────────────────────────
    {
      prefix:  'resumeScore:',
      owner:   'modules/resumeGrowth/resumeGrowth.engine.js',
      ttl:     3600,
      purpose: 'Resume quality score per user. Invalidated explicitly on resume upload.',
    },

    // ── Career readiness ──────────────────────────────────────────────────────
    {
      prefix:  'crs:det:',
      owner:   'modules/career-readiness/deterministic.engine.js',
      ttl:     900,
      purpose: 'Deterministic career readiness score keyed by input hash.',
    },

    // ── Job matching ──────────────────────────────────────────────────────────
    {
      prefix:  'job-match:',
      owner:   'modules/jobs/jobMatch.service.js',
      ttl:     600,
      purpose: 'Job match results per user.',
    },
    {
      prefix:  'job-matching:roles',
      owner:   'modules/jobs/jobMatch.service.js',
      ttl:     3600,
      purpose: 'Public role catalogue used by job matching (non-user-specific).',
    },

    // ── User ──────────────────────────────────────────────────────────────────
    {
      prefix:  'user-me:',
      owner:   'modules/users/users.service.js',
      ttl:     300,
      purpose: 'Authenticated user profile (/users/me) per userId.',
    },
    {
      prefix:  'token:verified:',
      owner:   'middleware/auth.middleware.js',
      ttl:     300,
      purpose: 'Verified JWT payload cache to reduce Supabase auth calls per request.',
    },

    // ── Personalization ───────────────────────────────────────────────────────
    {
      prefix:  'personalization:hydration:',
      owner:   'modules/dashboard/dashboard.service.js',
      ttl:     600,
      purpose: 'Personalization hydration payload per user.',
    },
    {
      prefix:  'personalization:profile:',
      owner:   'modules/dashboard/dashboard.service.js',
      ttl:     600,
      purpose: 'Personalization profile snapshot per user.',
    },

    // ── Conversion ────────────────────────────────────────────────────────────
    {
      prefix:  'hirerise:conversion:score:',
      owner:   'modules/conversion/utils/conversionCache.provider.js',
      ttl:     3600,
      purpose: 'Conversion funnel score per user for analytics attribution.',
    },

    // ── AI — Career copilot ───────────────────────────────────────────────────
    {
      prefix:  'career:advice:',
      owner:   'modules/career-copilot/coordinator/careerAgentCoordinator.js',
      ttl:     600,
      purpose: 'Career copilot advice response per user.',
    },
    {
      prefix:  'career:twin:',
      owner:   'modules/career-copilot/coordinator/careerAgentCoordinator.js',
      ttl:     600,
      purpose: 'Career digital twin snapshot keyed by role + profile hash.',
    },
    {
      prefix:  'rag:context:',
      owner:   'modules/career-copilot/coordinator/careerAgentCoordinator.js',
      ttl:     600,
      purpose: 'RAG retrieval context per user + cache version key.',
    },
    {
      prefix:  'semantic:',
      owner:   'modules/career-copilot/coordinator/careerAgentCoordinator.js',
      ttl:     1800,
      purpose: 'Semantic embedding cache per user profile hash.',
    },

    // ── AI — SLA observability ─────────────────────────────────────────────────
    {
      prefix:  'hirerise:sla:',
      owner:   'ai/observability/sla.service.js',
      ttl:     300,
      purpose: 'AI service SLA metrics (latency, error rate) per module and time window.',
    },

    // ── AI — Circuit breaker ──────────────────────────────────────────────────
    {
      prefix:           'circuit-breaker:',
      owner:            'ai/circuit-breaker/circuit-breaker.service.js',
      ttl:              0,
      ttlJustification: 'Circuit breaker state (OPEN/CLOSED/HALF-OPEN) must not expire via TTL. It transitions through explicit state machine events. Silent expiry would re-enable a broken AI service without a health check.',
      purpose:          'Circuit breaker state per AI service identifier.',
    },

    // ── Infrastructure cache ──────────────────────────────────────────────────
    {
      prefix:  'predictive:heat:',
      owner:   'infrastructure/cache/predictiveHeat.service.js',
      ttl:     900,
      purpose: 'Predictive cache heat scores for pre-warming decisions.',
    },
    {
      prefix:  'predictive:consensus:',
      owner:   'infrastructure/cache/predictiveConsensus.service.js',
      ttl:     300,
      purpose: 'Consensus signals for predictive cache warming.',
    },
    {
      prefix:  'analytics-cache:',
      owner:   'infrastructure/cache/analyticsCache.service.js',
      ttl:     600,
      purpose: 'Intermediate analytics aggregation results.',
    },

  ],
};
