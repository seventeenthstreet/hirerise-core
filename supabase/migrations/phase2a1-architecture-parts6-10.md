# HireRise Phase 2A.1 — Parts 6–10

---

## Part 6 — Explainable Intelligence Design

### 6.1 Attribution Model

Every intelligence output has a full attribution chain from raw evidence to final explanation. The attribution model has four tiers:

```
TIER 1 — EVIDENCE (what happened)
  student_signal_evidence
    source_type: explicit_response | activity_record | achievement_record | ...
    source_domain: academic | activity | cognitive
    contribution_weight: 0.0–1.0
    raw_confidence: 0.0–1.0

TIER 2 — SIGNAL (what it means)
  student_signal_vectors.signal_weights
    signal_key: 'systems_thinker', 'leadership_potential', ...
    aggregated weight from all evidence items for this signal

TIER 3 — CONFIDENCE (how certain)
  intelligence_confidence_snapshots
    composite_confidence: 0–100
    confidence_tier: HIGH | MEDIUM | LOW | NO_DATA
    factor decomposition: which signals drove the score

TIER 4 — EXPLANATION (what to tell the entity)
  intelligence_explanation_details
    contributing_signals: structured list with labels
    missing_signals:      what's absent and why it matters
    improvement_actions:  concrete next steps
    reasoning_trail:      ordered steps from signal to conclusion
```

### 6.2 Explanation Generation Architecture

Explanation generation is a deterministic, pure function. No LLMs. No AI agents. The explainability engine takes structured inputs and produces structured + text outputs via template resolution.

**Input contract:**
```typescript
interface ExplainabilityInput {
  entityId:          string;
  entityType:        EntityType;
  intelligenceDomain: IntelligenceDomain;
  confidenceSnapshot: ConfidenceSnapshotRecord;
  signalVector:       SignalVectorRecord;
  ontologyEdges:      OntologyEdge[];       // from signal_ontology_edges
  modelVersion:       ModelVersionRecord;    // from signal_weight_versions
  subjectType:        ExplainabilitySubjectType;
  subjectKey:         string;               // e.g. 'software_engineering'
  subjectLabel:       string;               // e.g. 'Software Engineering'
}
```

**Processing steps (all deterministic):**

```
Step 1 — Signal Attribution
  For each signal in signalVector with weight > 0:
    attribution_pct = signal_weight / sum(all_weights) × 100
  → signal_attribution map

Step 2 — Contributing Signal Ranking
  Sort by (contribution_score × evidence_confidence) DESC
  Take top N (N = 3 for HIGH, 2 for MEDIUM, 1 for LOW)
  Resolve label from signal_category_hierarchy.display_name
  → contributing_signals[]

Step 3 — Missing Signal Detection
  For each signal in model_version.weights WHERE signal_key NOT IN signal_vector:
    Classify as: critical (weight > 0.7) | recommended (>0.5) | optional (≤0.5)
    Resolve label from intelligence_signal_registry.display_name
  → missing_signals[]

Step 4 — Improvement Action Generation
  For each missing_signal WHERE importance = 'critical' | 'recommended':
    Resolve action via signal_ontology_edges WHERE edge_type = 'develops'
    Compute expected_confidence_gain = signal_weight × 0.8 (conservative)
  → improvement_actions[]

Step 5 — Reasoning Trail Assembly
  [
    { step: 1, type: 'signal', key: signal_key, label: '...', weight },
    { step: 2, type: 'absence', key: missing_key, label: '...', importance },
    { step: 3, type: 'relationship', key: ontology_edge_key, label: '...' }
  ]

Step 6 — Explanation Text Composition
  Template selection based on confidence_tier + output_type:
    HIGH + career_area:   "{subject_label} shows strong alignment — {top_signal_label}
                           and {second_signal_label} are consistently demonstrated."
    MEDIUM + career_area: "Your profile shows moderate evidence for {subject_label}.
                           {top_signal_label} supports this direction."
    LOW + career_area:    "Early signals suggest potential in {subject_label}.
                           More evidence is needed across {missing_count} areas."
    NO_DATA:              "Not enough signal data yet to evaluate {subject_label}."

Step 7 — Vocabulary Validation
  Pass explanation_text through confidence-language.registry (existing Phase 4B)
  vocabulary_valid = validation.valid
  vocabulary_violations = validation.violations

Step 8 — Persistence
  intelligence_explainability_snapshots INSERT  (governance layer — immutable)
  intelligence_explanation_details INSERT        (UI layer — structured)
```

### 6.3 Auditability Model

Every explanation is fully auditable across five dimensions:

| Dimension | Where stored | Query path |
|---|---|---|
| Who authorised this | `intelligence_consent_ledger` | via `pipeline_run_id → consent_ledger_id` |
| Which model produced it | `signal_weight_versions` | via `pipeline_run_id → model_version_id` |
| What signal evidence backed it | `student_signal_evidence` | via `signal_key + user_id + recorded_at` |
| What confidence score applied | `intelligence_confidence_snapshots` | via `entity_snapshot_id` |
| What text was shown | `intelligence_explainability_snapshots` | immutable text + vocabulary_valid |

**Government auditability query** (shows complete explanation provenance for a given snapshot):
```sql
SELECT
  es.snapshot_at,
  es.confidence_tier,
  es.explanation_text,
  es.vocabulary_valid,
  pr.engine_version,
  pr.started_at          AS run_started,
  cl.event_at            AS consent_granted_at,
  cl.consent_version,
  swv.version_tag        AS model_version,
  swv.intelligence_domain,
  ed.contributing_signals,
  ed.missing_signals,
  ed.improvement_actions
FROM public.intelligence_explainability_snapshots es
JOIN public.intelligence_pipeline_runs pr
  ON pr.id = es.pipeline_run_id
JOIN public.intelligence_consent_ledger cl
  ON cl.id = pr.consent_ledger_id
JOIN public.signal_weight_versions swv
  ON swv.id = pr.model_version_id
LEFT JOIN public.intelligence_explanation_details ed
  ON ed.explainability_snapshot_id = es.id
WHERE es.id = $1;
```

This query returns everything a regulator needs to verify any intelligence output: consent, model version, timing, text, vocabulary compliance, and the full structured decomposition. No additional audit tables needed.

---

## Part 7 — Aggregation Engine Design

### 7.1 Ingestion Flow

```
NEW DATA EVENT
  │
  ├─► Academic: student_academic_records
  │     source_type = 'subject_performance'
  │     source_domain = 'academic'
  │
  ├─► Activity: student_activities
  │     source_type = 'activity_record' | 'achievement_record' | 'reflection_entry'
  │     source_domain = 'activity'
  │
  └─► Cognitive: student_cognitive_responses
        source_type = 'explicit_response'
        source_domain = 'cognitive'
              │
              ▼
    IntelligenceService.runGovernedPipeline()
      → verifyConsent()                [HALT if no consent]
      → getActiveModelVersion()        [resolve signal_weight_versions]
      → openPipelineRun()              [create pipeline_runs record]
      → aggregationEngine.ingest()     [Step 7.2 below]
      → closePipelineRun()             [status = 'completed']
```

### 7.2 Signal Extraction (per data domain)

Each data domain has a domain-specific extractor. All extractors produce the same output shape: `SignalEvidenceRecord[]`.

**Academic extractor:**
```
Input:  student_academic_records rows for this user
Output: For each subject:
          signal_key = resolve_signal_from_subject(subject_code, stream)
            → uses signal_ontology_edges WHERE edge_type = 'evidenced_by'
          contribution_weight = normalize(grade, subject_weight, stream_weight)
          source_type = 'subject_performance'
          source_domain = 'academic'
```

**Activity extractor:**
```
Input:  student_activities + student_activity_achievements
Output: For each activity:
          signal_key = resolve_signal_from_activity(activity_type, role)
            → uses signal_ontology_edges WHERE edge_type = 'predicts'
          contribution_weight = normalize(role_weight, achievement_count, reflection_quality)
          source_type = 'activity_record' | 'achievement_record'
          source_domain = 'activity'
```

**Cognitive extractor:**
```
Input:  student_cognitive_responses joined to cognitive_options.signal_weights
Output: For each response:
          signal_key = cognitive_option.signal_weights key with highest weight
          contribution_weight = cognitive_option.signal_weights[signal_key]
          source_type = 'explicit_response'
          source_domain = 'cognitive'
```

All extracted evidence is written to `student_signal_evidence` with the `pipeline_run_id` from the open pipeline run.

### 7.3 Normalization Flow

After extraction, each signal's evidence items are normalized before aggregation:

```
For each signal_key in collected evidence:

  Step 1 — Weight Retrieval
    w = signal_weight_versions.weights[signal_key].weight
    strategy = signal_weight_versions.weights[signal_key].normalization
    domain_multiplier = signal_weight_versions.domain_overrides[source_domain]

  Step 2 — Per-Evidence Normalization (strategy = 'weighted_average')
    normalized_contribution = contribution_weight × w × domain_multiplier

  Step 3 — Cross-Evidence Aggregation (per signal_key)
    raw_signal_score = SUM(normalized_contribution) / evidence_count
    capped at 1.0

  Step 4 — Recency Weighting
    recency_weight = exp(-days_since_last_evidence / 365)
    final_signal_score = raw_signal_score × recency_weight
```

### 7.4 Aggregation Flow

```
For each signal_key with at least one evidence item:
  signal_weights[signal_key] = final_signal_score

domain_vectors[domain] = {
  score: mean(signal_scores WHERE source_domain = domain),
  signal_count: count(signal_keys WHERE source_domain = domain),
  coverage: active_signals / expected_signals_for_domain
}

evidence_summary = {
  total_evidence_items: count(all evidence rows),
  by_domain: { academic: N, activity: N, cognitive: N },
  oldest_evidence_at: min(recorded_at),
  newest_evidence_at: max(recorded_at)
}

Update student_signal_vectors:
  signal_weights = computed above
  domain_vectors = computed above
  evidence_summary = computed above
  pipeline_run_id = current run UUID
  domains_included = domains with at least one signal
  aggregated_at = now()
```

### 7.5 Output Contracts

**Aggregation Engine Output (→ Confidence Engine input):**
```typescript
interface AggregationOutput {
  entityId:          string;
  vectorId:          string;            // student_signal_vectors.id
  signalWeights:     Record<string, number>;
  domainVectors:     Record<string, DomainVector>;
  evidenceSummary:   EvidenceSummary;
  pipelineRunId:     string;
  modelVersionTag:   string;
  aggregatedAt:      string;
}
```

**Confidence Engine Output (→ Explainability Engine input):**
```typescript
interface ConfidenceOutput {
  entitySnapshotId:  string;
  compositeConfidence: number;
  confidenceTier:    ConfidenceTier;
  coverageScore:     number;
  reliabilityScore:  number;
  factors:           FactorDecomposition;
  missingSignals:    string[];
  uncertaintyBand:   number | null;
  pipelineRunId:     string;
}
```

**Explainability Engine Output (→ Recommendation Engine input + persistence):**
```typescript
interface ExplainabilityOutput {
  explainabilitySnapshotId: string;
  explanationDetailsId:     string;
  contributingSignals:      ContributingSignal[];
  missingSignals:           MissingSignal[];
  improvementActions:       ImprovementAction[];
  reasoningTrail:           ReasoningStep[];
  signalAttribution:        Record<string, number>;
  vocabularyValid:          boolean;
}
```

**Recommendation Engine Output (→ persistence):**
```typescript
interface RecommendationOutput {
  recommendations: Array<{
    outputType:          OutputType;
    outputKey:           string;
    outputLabel:         string;
    rank:                number;
    recommendationScore: number;
    confidenceTier:      ConfidenceTier;
    explanationText:     string;
    factors:             RecommendationFactor[];
  }>;
  pipelineRunId:         string;
  entitySnapshotId:      string;
}
```

### 7.6 Model Evolution Support

The aggregation engine resolves signal weights from `signal_weight_versions` at runtime — it never hardcodes weights. When a new model version is approved:

1. `fn_get_active_model_version('student', 'signal_weights')` returns the new version
2. The next pipeline run uses new weights automatically
3. The pipeline run records `model_version_id` → full audit trail
4. Historical runs remain traceable to their model version
5. Output hashes allow determinism verification: re-running with the same model version and inputs produces the same output hash

---

## Part 8 — API Architecture

### 8.1 Service Layer Design

The service layer follows the existing HireRise pattern: TypeScript services consumed by API controllers, using the service-role Supabase client for all writes, exposing RPCs for student-facing reads.

```
backend/src/services/
  intelligence.service.ts          [existing — governance orchestrator]
  aggregation.service.ts           [NEW — signal extraction + normalization]
  confidence.service.ts            [NEW — confidence calculation]
  explainability.service.ts        [NEW — explanation generation]
  recommendation.service.ts        [NEW — recommendation generation]
  snapshot.service.ts              [NEW — entity snapshot lifecycle]
```

**aggregation.service.ts** — core responsibilities:
```typescript
extractDomainSignals(userId, domain, pipelineRunId): Promise<SignalEvidenceRecord[]>
normalizeSignals(evidence, weights): NormalizedSignals
aggregateSignalVector(normalized, userId, pipelineRunId): Promise<AggregationOutput>
```

**confidence.service.ts** — core responsibilities:
```typescript
calculateCoverage(vector, registry): CoverageResult
calculateReliability(vector, evidence): ReliabilityResult
calculateComposite(coverage, reliability, recency): ConfidenceResult
persistConfidenceSnapshot(entitySnapshotId, result, pipelineRunId): Promise<string>
```

**explainability.service.ts** — core responsibilities:
```typescript
buildSignalAttribution(vector, weights): AttributionMap
identifyMissingSignals(vector, modelWeights, registry): MissingSignal[]
generateImprovementActions(missingSignals, ontologyEdges): ImprovementAction[]
composeExplanationText(tier, subjectLabel, contributing, missing): string
validateVocabulary(text, tier): VocabularyValidationResult
persistExplainabilitySnapshot(params): Promise<ExplainabilityOutput>
```

**recommendation.service.ts** — core responsibilities:
```typescript
resolveOutputCandidates(vector, ontologyEdges): OutputCandidate[]
scoreOutputCandidates(candidates, vector, weights): ScoredCandidate[]
rankAndFilter(scored, maxResults): RankedRecommendation[]
persistRecommendations(recommendations, entitySnapshotId, pipelineRunId): Promise<RecommendationOutput>
```

### 8.2 API Structure

All endpoints follow the existing HireRise three-tier pattern: `API Client → Controller → Service`. Student-facing endpoints use RPCs (no direct table access).

**Student Intelligence API (authenticated — student reads own data):**
```
GET  /api/intelligence/student/snapshot/latest
     → fn_get_student_intelligence_summary(user_id)
     Returns: { confidenceTier, compositeConfidence, topSignals[], topRecommendations[] }

GET  /api/intelligence/student/recommendations
     → fn_get_student_recommendations(user_id, output_type?, limit?)
     Returns: intelligence_recommendations rows + factors joined

GET  /api/intelligence/student/explanation/:recommendationId
     → fn_get_recommendation_explanation(recommendation_id, user_id)
     Returns: { recommendation, factors, contributing, missing, improvementActions }

GET  /api/intelligence/student/history
     → fn_get_intelligence_history(user_id, domain?)
     Returns: intelligence_confidence_snapshots time series

GET  /api/intelligence/student/consent
     → fn_get_consent_history(null, 'student')
     Returns: consent event history
```

**Admin / Pipeline API (service_role only):**
```
POST /api/intelligence/pipeline/trigger
     → IntelligenceController.triggerPipeline({ userId, domains })
     Calls: intelligence.service.ts runGovernedPipeline()

GET  /api/intelligence/admin/pipeline-runs/:userId
     → Direct service_role query on intelligence_pipeline_runs

GET  /api/intelligence/admin/signal-registry
     → Direct query on intelligence_signal_registry
```

**Governance RPCs (added to database):**
```sql
-- Student intelligence summary RPC
CREATE OR REPLACE FUNCTION public.fn_get_student_intelligence_summary(
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'latestSnapshot',   row_to_json(eis),
    'confidence',       row_to_json(ics),
    'recommendations',  (
      SELECT jsonb_agg(row_to_json(ir))
      FROM intelligence_recommendations ir
      WHERE ir.entity_id = p_user_id
        AND ir.entity_type = 'student'
      ORDER BY ir.rank
      LIMIT 5
    )
  )
  FROM intelligence_entity_snapshots eis
  LEFT JOIN intelligence_confidence_snapshots ics
    ON ics.entity_snapshot_id = eis.id
  WHERE eis.entity_id  = p_user_id
    AND eis.entity_type = 'student'
  ORDER BY eis.snapshot_at DESC
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.fn_get_student_intelligence_summary(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_get_student_intelligence_summary(uuid)
  TO authenticated, service_role;

-- Student recommendations RPC
CREATE OR REPLACE FUNCTION public.fn_get_student_recommendations(
  p_user_id    uuid,
  p_output_type text  DEFAULT NULL,
  p_limit      int    DEFAULT 10
)
RETURNS TABLE (
  recommendation_id    uuid,
  output_type          text,
  output_key           text,
  output_label         text,
  rank                 integer,
  recommendation_score numeric,
  confidence_tier      text,
  explanation_text     text,
  factors              jsonb
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    ir.id,
    ir.output_type,
    ir.output_key,
    ir.output_label,
    ir.rank,
    ir.recommendation_score,
    ir.confidence_tier,
    ir.explanation_text,
    (
      SELECT jsonb_agg(jsonb_build_object(
        'signal_key',    irf.signal_key,
        'factor_type',   irf.factor_type,
        'factor_label',  irf.factor_label,
        'contribution',  irf.contribution_score,
        'factor_rank',   irf.factor_rank
      ) ORDER BY irf.factor_rank)
      FROM intelligence_recommendation_factors irf
      WHERE irf.recommendation_id = ir.id
    ) AS factors
  FROM intelligence_recommendations ir
  WHERE ir.entity_id   = p_user_id
    AND ir.entity_type = 'student'
    AND (p_output_type IS NULL OR ir.output_type = p_output_type)
    AND (ir.expires_at IS NULL OR ir.expires_at > now())
  ORDER BY ir.rank
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION public.fn_get_student_recommendations(uuid, text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_get_student_recommendations(uuid, text, int)
  TO authenticated, service_role;
```

### 8.3 React Query Integration

Following the existing HireRise frontend pattern (three-tier: API client → typed hook → component):

```typescript
// Query keys — stable, cacheable, invalidation-friendly
export const INTELLIGENCE_QUERY_KEYS = {
  root:            ['intelligence']           as const,
  summary:         (userId: string) =>
                     ['intelligence', 'summary', userId] as const,
  recommendations: (userId: string, type?: string) =>
                     ['intelligence', 'recommendations', userId, type] as const,
  explanation:     (recId: string) =>
                     ['intelligence', 'explanation', recId] as const,
  history:         (userId: string) =>
                     ['intelligence', 'history', userId] as const,
  consent:         (userId: string) =>
                     ['intelligence', 'consent', userId] as const,
} as const;

// useStudentIntelligenceSummary hook
export function useStudentIntelligenceSummary(userId: string) {
  return useQuery({
    queryKey: INTELLIGENCE_QUERY_KEYS.summary(userId),
    queryFn:  () => intelligenceApi.getStudentSummary(userId),
    staleTime: 5 * 60 * 1000,        // 5 min — intelligence is not real-time
    gcTime:    30 * 60 * 1000,       // 30 min cache
    enabled:   Boolean(userId),
  });
}

// useStudentRecommendations hook
export function useStudentRecommendations(
  userId: string,
  outputType?: OutputType
) {
  return useQuery({
    queryKey: INTELLIGENCE_QUERY_KEYS.recommendations(userId, outputType),
    queryFn:  () => intelligenceApi.getRecommendations(userId, outputType),
    staleTime: 10 * 60 * 1000,      // 10 min — recommendations are stable
    enabled:   Boolean(userId),
  });
}

// useRecommendationExplanation hook
export function useRecommendationExplanation(recommendationId: string) {
  return useQuery({
    queryKey: INTELLIGENCE_QUERY_KEYS.explanation(recommendationId),
    queryFn:  () => intelligenceApi.getExplanation(recommendationId),
    staleTime: Infinity,              // Explanations are immutable — cache forever
    gcTime:    60 * 60 * 1000,
    enabled:   Boolean(recommendationId),
  });
}

// Trigger pipeline (mutation)
export function useRunIntelligencePipeline() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: TriggerPipelineInput) =>
      intelligenceApi.triggerPipeline(params),
    onSuccess: (_, { userId }) => {
      // Invalidate summary and recommendations after pipeline completes
      queryClient.invalidateQueries({
        queryKey: INTELLIGENCE_QUERY_KEYS.summary(userId)
      });
      queryClient.invalidateQueries({
        queryKey: INTELLIGENCE_QUERY_KEYS.recommendations(userId)
      });
    },
  });
}
```

### 8.4 Frontend Consumption Model

The student-facing intelligence UI has three display states driven by `confidence_tier`:

```
HIGH tier  → Full recommendation card with confidence score, 3 contributing signals,
             improvement actions optional

MEDIUM tier → Recommendation card with 2 contributing signals,
              missing signals highlighted, improvement actions prominent

LOW tier   → "Early signals" card — no specific recommendation score shown,
             missing signals list, improvement actions as primary CTA

NO_DATA    → "Not enough data yet" state — onboarding prompt
```

The frontend **never** renders raw signal weights, `signal_key` identifiers, or JSONB payloads directly. All rendering uses vocabulary-validated `explanation_text` and human-readable `factor_label` strings from the structured explanation details.

---

## Part 9 — Implementation Roadmap

### Sprint 1 — Signal & Ontology Foundation (Weeks 1–2)

**Objective:** Extend the signal registry with hierarchical categorization and ontology edges. Seed initial ontology data. Validate that signal_key resolution works end-to-end.

**Deliverables:**
- Migration `20260608000001_signal_category_hierarchy.sql`
  - `signal_category_hierarchy` table + indexes + RLS + GRANTs
  - Seed: 7 root categories + 15 level-1 subcategories covering all 12 Phase 3D signals
- Migration `20260608000002_signal_ontology_edges.sql`
  - `signal_ontology_edges` table + indexes + RLS + GRANTs
  - Seed: signal → career_area edges (predicts), signal → skill edges (evidenced_by)
  - Minimum: 12 signals × 3 career areas each = 36 seed edges
- `aggregation.service.ts` — `extractDomainSignals()` + `normalizeSignals()`
- Signal key validation RPC: `fn_validate_signal_keys(signal_keys text[])`

**Dependencies:** Migrations 000001–000004 deployed and verified (Sprint 1.1 complete)

**Estimated complexity:** Medium — 8 engineer-days  
Schema work: 4 days. Seed data curation: 2 days. Service + tests: 2 days.

**Migration requirements:**
- Must run AFTER 20260601000004
- Seed data requires agreement on initial career areas (minimum: technology, business, creative, social, science)
- `fn_validate_signal_keys()` RPC added before aggregation service can process evidence

**Risks:**
- Career area taxonomy must be agreed before ontology seed. If this is deferred, seed with `signal → career_area` edges for the 5 agreed areas and add more in Sprint 2.

---

### Sprint 2 — Longitudinal Snapshot + Confidence Engine (Weeks 3–4)

**Objective:** Build the entity snapshot layer and the structured confidence snapshot layer. Connect Phase 4A coverage/reliability tables to the new confidence snapshot table. Produce first governed intelligence entity snapshots.

**Deliverables:**
- Migration `20260615000001_entity_snapshots.sql`
  - `intelligence_entity_snapshots` table + triggers + indexes + RLS + GRANTs
  - `intelligence_confidence_snapshots` table + triggers + indexes + RLS + GRANTs
  - `fn_get_entity_snapshot_sequence()` RPC (returns next sequence number for entity)
  - `fn_get_intelligence_history()` RPC (time series for UI)
- Migration `20260615000002_seed_confidence_model_version.sql`
  - INSERT into `signal_weight_versions` where `model_type = 'confidence_model'`
  - Seeds COVERAGE_WEIGHT (0.4), RELIABILITY_WEIGHT (0.4), RECENCY_WEIGHT (0.2)
  - approved_at = now()
- `confidence.service.ts` — full implementation
  - `calculateCoverage()` — reads Phase 4A `signal_coverage_profiles`
  - `calculateReliability()` — reads Phase 4A `signal_reliability_scores`
  - `calculateComposite()` — pure function, deterministic
  - `persistConfidenceSnapshot()` — writes to `intelligence_confidence_snapshots`
- `snapshot.service.ts` — entity snapshot lifecycle
  - `openEntitySnapshot()`, `closeEntitySnapshot()`
  - `computeStateDelta()` — delta_from_previous calculation
- Integration: wire `confidence.service.ts` into `runGovernedPipeline()` callback

**Dependencies:** Sprint 1 complete. Phase 4A tables populated with at least one student's data.

**Estimated complexity:** High — 10 engineer-days  
Schema: 3 days. Confidence calculation logic: 4 days. Integration + tests: 3 days.

**Migration requirements:**
- `intelligence_confidence_snapshots.entity_snapshot_id` FK requires `intelligence_entity_snapshots` to exist first
- Confidence model version seed requires `signal_weight_versions` table (Migration 1)

**Risks:**
- The Phase 4A `signal_coverage_profiles` table uses a text `assessment_id` column with no FK — the confidence service must handle the case where assessment_id does not resolve to a pipeline_run_id. Map `assessment_id` to `pipeline_run_id` via a lookup in the service layer.

---

### Sprint 3 — Recommendation Framework + Explanation Engine (Weeks 5–6)

**Objective:** Build the recommendation and explanation layer. First end-to-end intelligence output: student opens dashboard and sees a vocabulary-validated career area recommendation with contributing signals, missing signals, and improvement actions.

**Deliverables:**
- Migration `20260622000001_recommendations.sql`
  - `intelligence_recommendations` table + indexes + RLS + GRANTs
  - `intelligence_recommendation_factors` table + indexes + RLS + GRANTs
  - `intelligence_explanation_details` table + triggers + indexes + RLS + GRANTs
  - `fn_get_student_recommendations()` RPC
  - `fn_get_recommendation_explanation()` RPC (returns explanation_details row)
  - Deprecation comments on `edu_skill_recommendations` and `personalized_recommendations`
- `recommendation.service.ts` — full implementation
  - `resolveOutputCandidates()` — queries `signal_ontology_edges` WHERE edge_type = 'predicts'
  - `scoreOutputCandidates()` — pure function, signal attribution weighted by ontology edge_weight
  - `rankAndFilter()` — deterministic ranking
  - `persistRecommendations()` — writes recommendations + factors
- `explainability.service.ts` — full implementation
  - All 8 generation steps from Section 6.2
  - `persistExplainabilitySnapshot()` — writes governance snapshot + explanation details
- `fn_get_student_intelligence_summary()` RPC (database)
- Frontend: `useStudentRecommendations` hook + recommendation card component
- Frontend: `useRecommendationExplanation` hook + explanation panel component

**Dependencies:** Sprint 2 complete. Entity snapshots producing data for at least one test student.

**Estimated complexity:** High — 12 engineer-days  
Schema: 3 days. Service layer: 5 days. Frontend: 3 days. Integration + tests: 1 day.

**Migration requirements:**
- `intelligence_recommendations.entity_snapshot_id` FK requires Sprint 2 tables
- `intelligence_explanation_details.explainability_snapshot_id` FK requires Migration 1 governance table
- Vocabulary validation requires `confidence-language.registry` to be imported in `explainability.service.ts`

**Risks:**
- Career area seed data in Sprint 1 determines what Sprint 3 can recommend. If the ontology seed is thin, recommendations will be thin. Prioritise Sprint 1 seed data quality.
- Template-based explanation text needs UX review before Sprint 3 ships — vocabulary is governed but templates are not.

---

### Sprint 4 — API Surface, React Query Integration, Phase 2A.1 Validation (Weeks 7–8)

**Objective:** Complete the API surface, wire all React Query hooks, validate the full Phase 2A.1 architecture end-to-end, and document readiness for Phase 2A.2 (Student Intelligence Core).

**Deliverables:**
- API controllers: `intelligenceController.ts`, `recommendationController.ts`
- All React Query hooks (`useStudentIntelligenceSummary`, `useStudentRecommendations`, `useRecommendationExplanation`, `useIntelligenceHistory`)
- React Query key registry (`intelligence.query-keys.ts`)
- Student intelligence dashboard — first UI consumer of the full Phase 2A.1 stack
- `fn_get_student_intelligence_summary()` RPC performance verification (target: < 100ms)
- Phase 2A.1 validation checklist (equivalent of Sprint 1 checklist)
- Architecture review: confirm Phase 2A.2 entry readiness
- Deprecation migration: add explicit `COMMENT` deprecations on `edu_skill_recommendations` and `personalized_recommendations`

**Dependencies:** Sprints 1–3 complete.

**Estimated complexity:** Medium — 8 engineer-days  
API layer: 3 days. Frontend: 3 days. Testing + validation: 2 days.

**Migration requirements:** No new tables. One deprecation migration.

---

## Part 10 — Future Expansion Validation

### How the Phase 2A.1 architecture supports all future domains

The Phase 2A.1 architecture is domain-agnostic at every layer. The following demonstrates specifically how each future module slots in with zero schema redesign.

---

### Professional Intelligence

**What changes:**
- New data ingestion: `professional_experience_records`, `certification_records`, `employer_feedback`
- New signal keys registered in `intelligence_signal_registry` under `primary_domain = 'professional'` (using the governance text column, not the Phase 3D enum)
- New model version: `signal_weight_versions INSERT (intelligence_domain='professional', model_type='signal_weights', version_tag='v1.0.0')`
- New ontology edges: `professional_signals → career_area, professional_signals → role`

**What does NOT change:**
- `intelligence_entity_snapshots`: `entity_type = 'professional'` already in CHECK constraint
- `intelligence_pipeline_runs`: `intelligence_domain = 'professional'` already in CHECK constraint
- `intelligence_confidence_snapshots`: same schema, same confidence calculation
- `intelligence_recommendations`: `entity_type = 'professional'` already valid
- `intelligence_consent_ledger`: `scope = 'professional_intelligence'` already in expanded vocabulary (Sprint 1.1)
- All governance RPCs: domain-parameterised

**New migration required:** One migration adding professional data ingestion tables and seeding professional signal registry rows + ontology edges. Zero governance schema changes.

---

### Institution Intelligence

**What changes:**
- Entity type: `entity_type = 'institution'` in entity snapshots (already valid)
- New signals: `graduate_employment_rate`, `curriculum_quality`, `industry_alignment`
- Institution entity ID: UUID from an `institutions` table (soft reference, already supported)
- New ontology edges: `institution_signals → programme, institution_signals → career_area`
- Consent model: institutions grant consent at admin level, not user level — `intelligence_domain = 'institution'` on consent ledger events

**What does NOT change:**
- All governance tables accept `entity_type = 'institution'`
- Confidence calculation is identical (coverage, reliability, composite)
- Recommendation output type `output_type = 'programme'` already defined in CHECK constraint
- Explainability generation is deterministic — same template engine with institution-specific templates

**New migration required:** Institution data tables + institution signal registry seed + consent collection for institution-level entities.

---

### Employer Intelligence

**What changes:**
- New signals: `hiring_velocity`, `skill_demand_signals`, `role_market_fit`
- Employer entity: `entity_type = 'employer'` (already valid)
- New output type: `output_type = 'development_action'` for employer-facing recommendations
- New model version: `(intelligence_domain='employer', model_type='signal_weights', version_tag='v1.0.0')`

**What does NOT change:** All governance infrastructure. Employer consent uses `intelligence_domain = 'employer'` — already valid in Sprint 1.1 scope vocabulary.

---

### Government / Workforce Intelligence

**What changes:**
- Entity type: `entity_type = 'government_region'` or `workforce_cohort`
- New signals aggregate across multiple student/professional entities — new aggregation strategy needed
- Output type: `output_type = 'development_action'` (policy recommendations for government)
- New model type: `model_type = 'clustering_model'` in model registry (already in CHECK constraint)

**What does NOT change:** The governance chain (consent → pipeline → model → snapshot) applies unchanged. Confidence calculation applies at the cohort level by averaging entity confidence scores. Explainability applies: government audit trail is already supported (Section 6.3 auditability query works for any entity type).

---

### Cross-Domain Aggregation

The `intelligence_domain = 'cross_domain'` value is already defined across all governance tables and the Phase 3D enum. Cross-domain recommendations (e.g., "Based on your student signals AND early professional exposure...") use:
- `entity_type` = primary entity type of the subject
- `intelligence_domain = 'cross_domain'`
- `domains_included[]` listing all contributing domains
- `signal_ontology_edges` to resolve cross-domain relationships

No schema changes required. The aggregation engine already handles `domains_included` — it is an array, not a single value.

---

### Schema change summary across all future modules

| Future module | New tables | New migrations | Governance changes |
|---|---|---|---|
| Professional Intelligence | 2–3 data tables | 1 migration | None |
| Employability Intelligence | 0 (cross-domain of student + professional) | 0 | None |
| Institution Intelligence | 1 institution profile table | 1 migration | None |
| Employer Intelligence | 2 data tables | 1 migration | None |
| Government Intelligence | 1 cohort aggregation table | 1 migration | None |
| Workforce Intelligence | Derived from above | 0–1 | None |

**Total governance schema changes across all future modules: zero.**

The governance foundation (Migrations 1–4) and the Intelligence Foundation Layer (Phase 2A.1) together form a permanently stable platform substrate. All future HireRise intelligence modules are new data tables and new service logic built on top of this substrate — not redesigns of it.

---

## Appendix — Deprecation Register

The following tables are explicitly deprecated by Phase 2A.1. No new writes after Sprint 3 ships.

| Table | Reason | Superseded by | Removal target |
|---|---|---|---|
| `edu_skill_recommendations` | Pre-governance, student-specific, no consent chain | `intelligence_recommendations` | Phase 2B |
| `personalized_recommendations` | Firebase-era text user_id, 10-minute expiry, no audit trail | `intelligence_recommendations` | Phase 2B |
| `edu_stream_scores` | Pre-governance stream scoring, no model versioning | `intelligence_confidence_snapshots` | Phase 2B |

Deprecation is applied via `COMMENT ON TABLE` in Sprint 4 migration. Rows are preserved — the tables are not dropped until Phase 2B confirms zero active callers.
