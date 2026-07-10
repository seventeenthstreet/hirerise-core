# WP-ARCH-01D — Enterprise Runtime Integration Architecture
## Canonical Student Academic Domain — Runtime Layer

**Predecessors (completed, approved, treated as authoritative — not redesigned in this document):**
- WP-ARCH-01A — Repository Evidence Report
- WP-ARCH-01A.2 — Business Semantic Investigation
- WP-ARCH-01B — Canonical Student Academic Domain Architecture
- WP-ARCH-01C — Enterprise Logical Data Model

**Scope of this document:** how the nine named enterprise runtimes that sit downstream of the Student Academic Domain collaborate with each other. This document does not touch the domain's aggregates, entities, or bounded contexts — it takes WP-ARCH-01B's Part 8 (Cross-Domain Integration) and WP-ARCH-01C's Parts 11–13 (Event Model, Projection Model, Cross-Domain Mapping) as fixed inputs and builds the runtime-to-runtime architecture on top of them.

**A note on evidence vs. design.** WP-ARCH-01A/A.2 confirmed, by direct code inspection, that today only two of these nine runtimes are real, wired, evidence-backed components: **Student Context Runtime** (`StudentService`, in `knowledge-runtime/student/studentIntelligence.service.js`) and **Recommendation Engine** (`RecommendationService`, `knowledge-runtime/recommendation/recommendation.service.js`), the latter depending exclusively on the former. Everything from Decision Engine onward — Decision Engine, Career Intelligence, Career Outcome Intelligence Engine, FYUGP Intelligence, AI Context Generation — was found by WP-ARCH-01A.2 §12 to be either not yet built, or referenced only in passing by another module's header comments, with no independent confirmation. This document is therefore a **target-state architecture for a landscape that is currently two-ninths implemented**, not a description of nine live runtimes. Every part below states this explicitly where it matters, so implementation teams know which contracts are being retrofitted onto working code and which are being specified for the first time.

---

## PART 1 — Enterprise Runtime Vision

### 1.1 Purpose

The Student Academic Domain (WP-ARCH-01B/C) is the single canonical source of truth for a student's academic identity, performance, cognitive, and activity data. Nine enterprise runtimes need some shape of that truth to do their own job — none of them owns it, and none of them should ever be tempted to duplicate it, because WP-ARCH-01A.2 §7.3 already found exactly one place where a component quietly built its own six-table shortcut around the proper composition layer. This document exists to make that shortcut structurally impossible for the next nine runtimes, not just discouraged by convention.

### 1.2 Design philosophy

- **Composition over duplication.** A runtime that needs academic data consumes a projection assembled by someone else; it never re-derives that projection itself from raw entities it doesn't own.
- **One authoritative shape per layer.** Each runtime produces exactly one canonical output shape for the runtime(s) downstream of it. If two different consumers need different slices, they slice the same canonical output — they don't cause the producer to grow two competing output shapes.
- **Runtimes are read-only with respect to everything upstream of them.** A runtime may own state that is genuinely its own (e.g. a Decision Engine's own decision log), but it never writes back into a domain or runtime that sits above it in the chain.
- **The chain is a pipeline, not a mesh.** Information flows in one direction — Student Academic Domain → Student Context Runtime → Knowledge Runtime → Recommendation Engine → Decision Engine → Career Intelligence → Career Outcome Intelligence Engine / FYUGP Intelligence → AI Context Generation — with narrowly-scoped, explicitly justified exceptions carried forward unchanged from WP-ARCH-01B Part 8 (Career Intelligence's direct read of Derived Academic Signals; Career Outcome Intelligence Engine's direct read of immutable Academic Record history). This document does not introduce any new exception beyond those two.
- **Everything is versioned and everything is explainable.** A runtime that cannot say which upstream version it composed from, and cannot be asked "why did you produce this," is not compliant with this architecture, regardless of how correct its output looks today.

### 1.3 Runtime collaboration principles

1. A runtime declares its **canonical inputs** (what it is allowed to consume) and its **produced outputs** (what it publishes) — nothing else crosses its boundary.
2. A runtime never reaches around its declared input to a runtime two or more layers upstream, except at the two documented exception points.
3. A runtime's internal computation logic (models, scoring, prompts) is its own business; this document governs only what crosses its boundary, in which direction, and under what contract.
4. Every cross-runtime data exchange is a **projection**, not a live query against another runtime's operational state.
5. Every cross-runtime trigger is an **event**, not a polling loop or a direct synchronous call chain that couples runtime availability to its neighbors'.

### 1.4 Ownership model — read vs. write responsibility

| Layer | Owns (write authority) | Reads from |
|---|---|---|
| Student Academic Domain | All academic entities (WP-ARCH-01C Parts 3–4) | Nothing upstream (domain root) |
| Student Context Runtime | Student Context projection (cross-domain composition, of which Academic Context is one input) | Academic Context (E-10) + equivalent projections from other domains (career, professional, personalization — outside this WP's scope) |
| Knowledge Runtime | Knowledge Runtime projection | Student Context projection + non-academic knowledge sources (opportunities, market data) |
| Recommendation Engine | Recommendation projection (transient, per-request) + its own recommendation output log | Knowledge Runtime projection |
| Decision Engine | Decision projection (transient, per-request) + its own decision log | Knowledge Runtime projection, Recommendation projection |
| Career Intelligence | Career Intelligence projection + its own career-path model state | Decision projection + Derived Academic Signal (E-09, direct, justified exception) |
| Career Outcome Intelligence Engine | Its own longitudinal outcome model state | Career Intelligence projection + immutable Academic Record history (E-05/E-06, direct, justified exception) |
| FYUGP Intelligence | Its own program-matching model state | Academic Context (E-10, direct — per WP-ARCH-01B Part 8, this integration has no confirmed legacy behavior to preserve, so it is specified prospectively on the same read-only-projection rule as everyone else) |
| AI Context Generation | The assembled AI Context bundle (its sole output) | Knowledge Runtime projection, Career Intelligence projection, Derived Academic Signal (direct) |

### 1.5 Why runtime composition is preferred over data duplication

WP-ARCH-01A.2 §0 and §7.3 already produced the counter-example this principle is designed against: a second "recommendation engine" that independently re-queried six raw tables instead of going through `StudentService`, with no version provenance on any of the six reads. Composition avoids this because:

- A consumer that composes from one upstream projection inherits that projection's versioning, freshness, and explainability guarantees for free; a consumer that re-derives its own copy must re-invent all three, and — as the evidence shows — usually doesn't.
- Duplication creates N independently-drifting copies of "what does this student's academic picture look like," each potentially stale relative to the others, with no mechanism to detect the drift until two engines disagree in front of a user.
- Composition keeps the domain's single-writer principle (WP-ARCH-01C Part 14 rule 2) meaningful all the way downstream — it is not enough that only one context can write an entity if six unrelated runtimes can each independently read-and-reshape it into six different "facts."

---

## PART 2 — Runtime Catalogue

For each runtime, evidence status is stated first, since it materially affects how the contract should be read by an implementation team.

### 2.1 Student Onboarding

- **Evidence status:** Confirmed live and active (WP-ARCH-01A §5).
- **Purpose:** Orchestrate the workflow through which a student establishes and updates their academic identity.
- **Responsibilities:** UI/workflow orchestration only. Issues commands into the Student Academic Domain; never persists academic data itself (WP-ARCH-01B Part 8).
- **Canonical inputs:** Student-entered form data; Academic Taxonomy Context reference data (for populated dropdowns/selectors).
- **Produced outputs:** Commands to the Student Academic Domain (establish/update profile, start qualification, select subjects, commit records).
- **Owned data:** None — this is the domain's stated boundary, carried forward unchanged.
- **Consumed projections:** Academic Taxonomy (read-only, for form population).
- **Published events:** None domain-relevant — its command/response interaction is synchronous per-step (WP-ARCH-01C Part 13).
- **Consumed events:** `AcademicProfileEstablished`, `QualificationStarted`, `SubjectSelected`, `AcademicRecordCommitted` (for step-progression UI feedback only).
- **Failure impact:** A Student Onboarding outage blocks new academic data entry; it does not corrupt or block any downstream runtime's ability to serve already-composed projections.
- **Recovery strategy:** Stateless workflow orchestrator — restart and resume from the domain's own command acknowledgement state, no runtime-specific recovery needed.
- **Lifecycle / Versioning:** Independent release cadence; versioned against the Academic Taxonomy Version it was built to render, not against any downstream runtime.

### 2.2 Student Context Runtime

- **Evidence status:** Confirmed live and active — `StudentService`, `knowledge-runtime/student/studentIntelligence.service.js` (WP-ARCH-01A.2 §7.1).
- **Purpose:** Compose the full cross-domain picture of a student (academic + career + professional + personalization) into one coherent Student Context.
- **Responsibilities:** Merge Academic Context with equivalent projections from other domains; never present a field as available unless its source is directly confirmed (a data-honesty convention WP-ARCH-01A.2 §9 found already enforced in code — this document elevates it to an architectural rule, Part 10.3).
- **Canonical inputs:** Academic Context (E-10) from the Student Academic Domain; equivalent current-state projections from other domains (out of this WP's scope to define).
- **Produced outputs:** Student Context projection.
- **Owned data:** The Student Context projection itself (a rebuildable read model — no independent write path, mirroring ADR-10 of WP-ARCH-01B).
- **Consumed projections:** Academic Context.
- **Published events:** A Student Context refresh signal, consumed by Knowledge Runtime.
- **Consumed events:** `AcademicContextRefreshed`, plus equivalent refresh events from other domains.
- **Failure impact:** Knowledge Runtime (and everything downstream of it) serves stale Student Context until this runtime recovers; academic data entry and domain integrity are unaffected.
- **Recovery strategy:** Full rebuild from the latest `AcademicContextRefreshed` (and sibling-domain) events — replay-safe by construction, per the domain's own replay guarantee (WP-ARCH-01C Part 8).
- **Lifecycle / Versioning:** Student Context carries a Context Version independent of, but referencing, the Academic Context Version it was composed from (traceability requirement, Part 6).
- **Justification for existing:** Without this layer, every downstream runtime would need to separately merge academic data with career/professional/personalization data, multiplying integration surfaces by the number of domains — exactly the N-copies risk Part 1.5 describes.

### 2.3 Knowledge Runtime

- **Evidence status:** Layering confirmed by evidence (WP-ARCH-01A.2 §7.1–7.2 establish `RecommendationService` depends on `StudentService`/`KnowledgeService`); the runtime's own internal composition logic beyond that dependency edge was not independently traced (WP-ARCH-01A.2 §12).
- **Purpose:** Compose Student Context with broader platform knowledge (opportunities, market data, taxonomy-driven domain knowledge) into a single reasoning substrate for every downstream intelligence runtime.
- **Responsibilities:** Own the "what does the platform collectively know that's relevant to this student" question; never let Recommendation or Decision reach past it to Student Context Runtime or the domain directly.
- **Canonical inputs:** Student Context projection; non-academic knowledge sources (opportunities, market data — outside this domain's scope to define further).
- **Produced outputs:** Knowledge Runtime projection.
- **Owned data:** The Knowledge Runtime projection.
- **Consumed projections:** Student Context.
- **Published events:** A knowledge-refresh signal.
- **Consumed events:** The Student Context refresh signal; events from non-academic knowledge sources.
- **Failure impact:** Every downstream runtime (Recommendation, Decision, and transitively Career Intelligence, Career Outcome Intelligence Engine, AI Context Generation) is blocked or degraded — this is the single highest-blast-radius runtime in the chain, since five of the remaining six runtimes depend on it directly or transitively.
- **Recovery strategy:** Event-driven or on-demand rebuild from Student Context plus knowledge-source events, per this runtime's own refresh model (WP-ARCH-01C Part 12 leaves the exact mechanism to this runtime's own design, deliberately, since it spans beyond the academic domain).
- **Lifecycle / Versioning:** Knowledge Runtime projection carries its own version, referencing the Student Context Version composed from.
- **Justification for existing:** Separates "what do we know" from "what do we recommend" — a scoring/recommendation change should never require touching how knowledge is assembled, and a new knowledge source should never require touching recommendation logic.

### 2.4 Recommendation Engine

- **Evidence status:** Confirmed live and active — `RecommendationService`, `knowledge-runtime/recommendation/recommendation.service.js`, constructor-enforced dependency on `studentService`/`knowledgeService` (WP-ARCH-01A.2 §7.2). **A second, non-compliant component of the same name exists** (`student-onboarding/services/recommendation-engine.js`) that bypasses this entire architecture by querying six raw tables directly (WP-ARCH-01A.2 §7.3); WP-ARCH-01B ADR-06 already ruled this path closed, and this document does not re-open it or grant it a contract.
- **Purpose:** Produce recommendation output for a specific request, using only what Knowledge Runtime composed.
- **Responsibilities:** Recommendation scoring/ranking logic; no independent repository access to any academic table, directly or indirectly (this is the one non-negotiable constraint carried forward from WP-ARCH-01B ADR-06).
- **Canonical inputs:** Knowledge Runtime projection.
- **Produced outputs:** Recommendation projection (per-request, transient) plus a persisted recommendation output log for auditability.
- **Owned data:** Its own recommendation output log.
- **Consumed projections:** Knowledge Runtime projection.
- **Published events:** A recommendation-completed signal, consumed by Decision Engine.
- **Consumed events:** The knowledge-refresh signal (to know when cached inputs are stale, if any caching is used).
- **Failure impact:** Decision Engine cannot proceed for affected requests; Knowledge Runtime and everything upstream is unaffected.
- **Recovery strategy:** Stateless per-request computation — no rebuild needed beyond re-running the request against current Knowledge Runtime state.
- **Lifecycle / Versioning:** Every recommendation output is stamped with the Knowledge Runtime projection version it was computed from (explainability requirement, Part 6).

### 2.5 Decision Engine

- **Evidence status:** Not independently confirmed as built; WP-ARCH-01A.2 §12 confirms only that it sits "downstream of `StudentService`/`KnowledgeService`," nothing further. **This contract is prospective.**
- **Purpose:** Produce a decision (e.g. a specific pathway or action determination) from Knowledge Runtime and Recommendation Engine output.
- **Responsibilities:** Decision logic and business rule application; no direct domain or Student Context Runtime access.
- **Canonical inputs:** Knowledge Runtime projection, Recommendation projection.
- **Produced outputs:** Decision projection (per-request) plus a persisted decision log.
- **Owned data:** Its own decision log — this is the platform's deterministic-scoring authority boundary (per the long-standing platform principle that AI augments presentation, never overrides deterministic decisions) and must remain independently auditable.
- **Consumed projections:** Knowledge Runtime projection, Recommendation projection.
- **Published events:** A decision-completed signal, consumed by Career Intelligence.
- **Consumed events:** The recommendation-completed signal.
- **Failure impact:** Career Intelligence and everything downstream of it is blocked for affected requests.
- **Recovery strategy:** Stateless per-request computation against current upstream projections.
- **Lifecycle / Versioning:** Every decision is stamped with both the Knowledge Runtime and Recommendation projection versions it was computed from.

### 2.6 Career Intelligence

- **Evidence status:** Not independently confirmed as built (WP-ARCH-01A.2 §7.5, §12). **This contract is prospective**, except for the one deliberate exception (direct Derived Academic Signal consumption) that WP-ARCH-01B Part 8 already specified.
- **Purpose:** Produce career-path intelligence by combining Decision Engine output with Derived Academic Signals and career-domain data.
- **Responsibilities:** Career-path modeling; the one runtime in this chain permitted to reach two layers upstream (to Derived Academic Signal, E-09) because that signal is a purpose-built, already-versioned publication surface, not a raw entity (WP-ARCH-01B Part 8).
- **Canonical inputs:** Decision projection; Derived Academic Signal (E-09, direct); career-domain data (outside this WP's scope).
- **Produced outputs:** Career Intelligence projection.
- **Owned data:** Its own career-path model state.
- **Consumed projections:** Decision projection.
- **Consumed direct signals:** Derived Academic Signal.
- **Published events:** A career-intelligence-refreshed signal, consumed by Career Outcome Intelligence Engine and AI Context Generation.
- **Consumed events:** The decision-completed signal; `DerivedSignalComputed`.
- **Failure impact:** Career Outcome Intelligence Engine and AI Context Generation lose one of their two/three inputs respectively; both should degrade gracefully rather than fail outright, per Part 9's health model.
- **Recovery strategy:** Event-driven and on-demand hybrid rebuild, per WP-ARCH-01C Part 12.
- **Lifecycle / Versioning:** Stamped with Decision projection version and E-09 signal version(s) consumed.

### 2.7 Career Outcome Intelligence Engine

- **Evidence status:** Not independently confirmed as built (WP-ARCH-01A.2 §12). **This contract is prospective**, except for the one deliberate exception (direct immutable Academic Record history read) already specified by WP-ARCH-01B Part 8.
- **Purpose:** Longitudinal analysis of academic-to-career outcomes over time.
- **Responsibilities:** Outcome modeling using genuine historical trend data; this is the second and last runtime permitted to reach past the standard chain, specifically because Academic Record history (E-05/E-06) is immutable and append-only (WP-ARCH-01B ADR-04), making a direct historical read safe in a way a direct read of mutable state would not be.
- **Canonical inputs:** Career Intelligence projection; immutable Academic Record history (E-05/E-06, direct, read-only).
- **Produced outputs:** Longitudinal outcome intelligence (its own model state; no further downstream runtime consumes it directly in the named chain, though future runtimes may).
- **Owned data:** Its own outcome model state.
- **Consumed projections:** Career Intelligence projection.
- **Consumed direct history:** `AcademicRecordCommitted`/`AcademicRecordAmended` events, read-only, in Record Version order (WP-ARCH-01C Part 13).
- **Published events:** An outcome-intelligence-updated signal (for any future consumer; not currently consumed by a named runtime in this catalogue).
- **Consumed events:** The career-intelligence-refreshed signal; `AcademicRecordCommitted`/`AcademicRecordAmended`.
- **Failure impact:** Isolated to this runtime's own longitudinal reporting; no other named runtime depends on its output today.
- **Recovery strategy:** Batch/periodic rebuild, given the longitudinal use case (WP-ARCH-01C Part 13) — does not need to be real-time-replay-safe in the way per-request runtimes do.
- **Lifecycle / Versioning:** Stamped with the Career Intelligence projection version and the Record Version range of history analyzed.

### 2.8 FYUGP Intelligence

- **Evidence status:** WP-ARCH-01A.2 §7.5 found **no confirmed direct evidence** of this runtime's current data dependencies. **This contract is entirely prospective**, specified on the same read-only-projection rule as every other consumer, with no exception carried forward from unconfirmed legacy behavior (WP-ARCH-01B Part 8).
- **Purpose:** Match students to undergraduate program (FYUGP) pathways using their current academic qualification, stream, and level.
- **Responsibilities:** Program-matching logic against the qualification/stream/level slice of a student's academic picture.
- **Canonical inputs:** Academic Context (E-10, direct).
- **Produced outputs:** FYUGP program-match intelligence (its own model state).
- **Owned data:** Its own program-matching model state.
- **Consumed projections:** Academic Context.
- **Published events:** An FYUGP-match-updated signal (available for future consumers; none named in this catalogue today).
- **Consumed events:** `AcademicContextRefreshed`.
- **Failure impact:** Isolated to program-matching output; no other named runtime in this catalogue depends on it.
- **Recovery strategy:** Event-driven rebuild on `AcademicContextRefreshed`.
- **Lifecycle / Versioning:** Stamped with the Academic Context Version consumed.
- **Why it reads Academic Context directly rather than through Student Context Runtime:** its inputs (qualification/stream/level) are purely academic and already fully represented in the Academic Context projection; routing through Student Context Runtime would add a dependency on cross-domain composition for data this runtime doesn't need cross-domain context to interpret. This is a deliberate, narrow scope decision, not a precedent for other runtimes to also skip layers.

### 2.9 AI Context Generation

- **Evidence status:** WP-ARCH-01A.2 §7.5, §12 found no independent confirmation this runtime is built; header-comment references only, explicitly flagged as unconfirmed. **This contract is prospective.** This is also the integration point WP-ARCH-01B Part 8 explicitly designed to prevent recurrence of the ungrounded direct-table-read pattern found in `recommendation-engine.js` (§7.3) — i.e., this runtime's discipline matters more than most, since it is the one that would otherwise be most tempted to "just read everything directly" for prompt convenience.
- **Purpose:** Assemble the final AI-facing context bundle from every upstream intelligence output, with full version provenance.
- **Responsibilities:** Bundle assembly and provenance stamping only. Per the WP-ARCH-01D brief's own constraint, this document does not design prompts or LLM logic — only the enterprise context architecture that a prompt-assembly layer would later consume.
- **Canonical inputs:** Knowledge Runtime projection; Career Intelligence projection; Derived Academic Signal (E-09, direct).
- **Produced outputs:** The assembled AI Context bundle.
- **Owned data:** The AI Context bundle itself (no independent write path back into any upstream runtime).
- **Consumed projections:** Knowledge Runtime projection, Career Intelligence projection.
- **Consumed direct signals:** Derived Academic Signal.
- **Published events:** An AI-context-generated signal (terminal in this catalogue — no further named runtime consumes it, though it is the artifact ultimately handed to prompt-assembly/LLM-facing components outside this WP's scope).
- **Consumed events:** The knowledge-refresh signal; the career-intelligence-refreshed signal; `DerivedSignalComputed`.
- **Failure impact:** Terminal — affects only AI-facing features; no other named runtime depends on this runtime's output.
- **Recovery strategy:** Event-driven plus on-demand generation (WP-ARCH-01C Part 12).
- **Lifecycle / Versioning:** Every bundle is stamped with every upstream version it assembled from — this is the single most version-dense artifact in the entire chain, deliberately, because it is the artifact furthest from the source of truth and therefore has the most to lose from silent staleness.

---

## PART 3 — Runtime Collaboration Model

### 3.1 Information flow

```
Student Academic Domain
        │  (Academic Context, E-10)
        ▼
Student Context Runtime  ──── merges academic + career + professional + personalization
        │  (Student Context)
        ▼
Knowledge Runtime  ──── merges Student Context + platform knowledge (opportunities, market data)
        │  (Knowledge Runtime projection)
        ▼
Recommendation Engine  ──── per-request recommendation output
        │  (Recommendation projection)
        ▼
Decision Engine  ──── per-request decision output
        │  (Decision projection)
        ▼
Career Intelligence  ◄──── Derived Academic Signal (direct, justified exception)
        │  (Career Intelligence projection)
        ├──────────────────────────────┐
        ▼                              ▼
Career Outcome Intelligence Engine   AI Context Generation ◄── Knowledge Runtime projection (direct)
        ▲                                                  ◄── Derived Academic Signal (direct)
        │  (immutable Academic Record history, direct, justified exception)
        │
Student Academic Domain (Performance Context)

FYUGP Intelligence ◄── Academic Context (direct, parallel branch — does not sit in the main chain)
```

### 3.2 Responsibility flow

Each runtime in the main chain is responsible only for the transformation between its declared input and its declared output — it is never responsible for re-verifying or re-deriving anything its input projection already guarantees. This is the direct runtime-layer expression of WP-ARCH-01C Part 14 rule 1 (canonical ownership): just as every academic entity has exactly one bounded-context owner, every transformation in this chain has exactly one runtime owner, and no runtime duplicates a transformation another runtime already performs.

### 3.3 Decision flow

Decision-making authority is concentrated in Decision Engine and is explicitly deterministic-scoring-authoritative: Recommendation Engine ranks and surfaces options, but Decision Engine is where a business decision is actually made. Career Intelligence and everything downstream consume the outcome of that decision — they do not re-decide. AI Context Generation in particular assembles context for AI-facing presentation but never overrides or re-derives a decision Decision Engine already made; this preserves the platform's core "deterministic scoring authority, AI as read-only presentation-layer augmentation" principle at the runtime-integration level, not just at the domain level.

### 3.4 Context enrichment

Context is enriched additively at each layer — Student Context Runtime adds cross-domain breadth, Knowledge Runtime adds platform knowledge, Recommendation/Decision add computed judgments, Career Intelligence adds signal-derived career framing, AI Context Generation adds provenance and final assembly. No layer removes or reinterprets a fact established by an earlier layer; if a later layer needs a different shape of an earlier fact, it requests that shape be added to the earlier layer's projection (a projection-schema change, Part 4), not a local reinterpretation.

### 3.5 AI context assembly

AI Context Generation is the only runtime whose entire purpose is assembly rather than transformation. It is deliberately positioned to read from three points (Knowledge Runtime, Career Intelligence, Derived Academic Signal) rather than one, because an AI-facing bundle legitimately needs both the "current state of knowledge" view and the "career-framed decision outcome" view side by side — collapsing these into a single upstream projection would force Knowledge Runtime or Career Intelligence to grow AI-specific shape, coupling their design to a downstream consumer's needs.

### 3.6 Projection ownership

Every projection in Part 4 below has exactly one owning runtime. A projection is never jointly owned, and no runtime other than its owner may publish a "refreshed" event for it.

### 3.7 Synchronization strategy

The dominant synchronization mode across the chain is event-driven refresh (a projection is rebuilt when its declared source events fire), with two runtimes (Recommendation Engine, Decision Engine) operating on-demand per request rather than maintaining a standing projection, since their output is inherently request-scoped rather than student-scoped. Career Outcome Intelligence Engine is the one runtime for which batch/periodic synchronization is appropriate rather than event-driven, given its longitudinal-analysis purpose does not benefit from per-event recomputation.

---

## PART 4 — Enterprise Projection Architecture

| Runtime | Input projections | Output projections | Ownership | Refresh trigger | Event trigger | Rebuild strategy | Replay strategy | Version compatibility |
|---|---|---|---|---|---|---|---|---|
| Student Context Runtime | Academic Context + sibling-domain projections | Student Context | Student Context Runtime | Any relevant source-domain event | `AcademicContextRefreshed` + sibling events | Full rebuild from latest source projections | Replay-safe: rebuild is idempotent per triggering event | Additive-only; new source domains are additive inputs |
| Knowledge Runtime | Student Context | Knowledge Runtime projection | Knowledge Runtime | Student Context refresh, or non-academic knowledge-source events | Student Context refresh signal | Event-driven or on-demand, per this runtime's own design | Must be replayable from Student Context + knowledge-source event history | Downstream consumers tolerate additive shape changes only |
| Recommendation Engine | Knowledge Runtime projection | Recommendation projection (transient) | Recommendation Engine | Per-request | Knowledge Runtime refresh signal (for cache invalidation only) | Recomputed per request — no standing state to rebuild | N/A (stateless per request) | Recommendation output log entries are immutable once written |
| Decision Engine | Knowledge Runtime + Recommendation projections | Decision projection (transient) | Decision Engine | Per-request | Recommendation-completed signal | Recomputed per request | N/A (stateless per request) | Decision log entries are immutable once written |
| Career Intelligence | Decision projection + Derived Academic Signal (direct) | Career Intelligence projection | Career Intelligence | Decision-completed signal, or `DerivedSignalComputed` | Both of the above | Event-driven and on-demand hybrid | Must be replayable from Decision projection history + signal history | Additive-only |
| Career Outcome Intelligence Engine | Career Intelligence projection + immutable Academic Record history (direct) | Longitudinal outcome intelligence | Career Outcome Intelligence Engine | Batch/periodic | `AcademicRecordCommitted`/`AcademicRecordAmended` (batched) | Periodic full or incremental rebuild over the Record Version range since last run | Must reproduce identical output for an identical Record Version range | Additive-only |
| FYUGP Intelligence | Academic Context (direct) | FYUGP program-match intelligence | FYUGP Intelligence | `AcademicContextRefreshed` | Same | Event-driven rebuild | Replayable from Academic Context history | Additive-only |
| AI Context Generation | Knowledge Runtime + Career Intelligence projections + Derived Academic Signal (direct) | AI Context bundle | AI Context Generation | Any of the three upstream signals | Knowledge refresh, career-intelligence refresh, `DerivedSignalComputed` | Event-driven plus on-demand generation | Must be replayable and must reproduce an equivalent bundle for an identical set of upstream versions | Additive-only; a breaking bundle-shape change requires a new bundle version namespace |

**Why projections over direct entity access (runtime layer restatement of WP-ARCH-01B ADR-06 and ADR-10):** a projection is a stable, versioned contract a downstream runtime can depend on without needing to understand its producer's internal aggregate structure. Direct entity access couples every consumer to every producer's internal schema, meaning a producer can never refactor its own internals without a coordinated multi-runtime migration — which is precisely the coupling this nine-runtime landscape cannot afford to accumulate as more runtimes are added (Part 10.12).

---

## PART 5 — Enterprise Event Collaboration

| Runtime (publisher) | Published events | Consumers | Ordering | Idempotency | Replay behaviour | Failure handling | Dead-letter strategy | Event retention | Provenance |
|---|---|---|---|---|---|---|---|---|---|
| Student Academic Domain | `AcademicContextRefreshed` (and E-01–E-09 events per WP-ARCH-01C Part 11) | Student Context Runtime | Strictly ordered per profile (Context Version monotonic) | Re-processing the same source event twice must not double-publish | Full reconstruction must be possible from a profile's complete history | Domain-owned; out of this WP's scope to redefine | Domain-owned | Domain-owned (indefinite, per WP-ARCH-01C Part 9) | Carries source Academic Context Version |
| Student Context Runtime | Student-Context-refreshed | Knowledge Runtime | Ordered per student (Context Version monotonic) | Re-publishing an equivalent context is a no-op | Rebuildable from Academic Context + sibling-domain history | On failure, Knowledge Runtime continues serving its last-known-good Knowledge Runtime projection rather than blocking | Failed refreshes retried with backoff; persistent failure surfaces to Part 9's health model, not silently dropped | Retained at least as long as the longest-lived downstream consumer's replay window | Carries Academic Context Version + sibling-domain versions composed from |
| Knowledge Runtime | Knowledge-refreshed | Recommendation Engine, Decision Engine (via Recommendation), AI Context Generation | Ordered per student | Re-publishing an equivalent projection is a no-op | Rebuildable from Student Context + knowledge-source event history | Recommendation Engine falls back to its last successfully-fetched Knowledge Runtime projection for in-flight requests, flagged as potentially stale | Retried with backoff; escalates to health model on persistent failure | At least as long as Recommendation/AI Context Generation's own replay windows | Carries Student Context Version + knowledge-source versions |
| Recommendation Engine | Recommendation-completed | Decision Engine | Ordered per request | Re-delivery of a completed recommendation is a no-op (keyed on request ID) | Not a rebuild target — a failed request is simply re-run | Decision Engine treats a missing recommendation-completed signal as "not yet ready," never as "empty recommendation" | N/A — request-scoped, not a durable stream requiring dead-lettering beyond standard request retry | Retained per the recommendation output log's own retention policy | Carries Knowledge Runtime projection version |
| Decision Engine | Decision-completed | Career Intelligence | Ordered per request | Keyed on request ID; re-delivery is a no-op | Not a rebuild target — re-run the request | Career Intelligence treats a missing signal as "not yet ready" | Standard request retry | Retained per the decision log's own retention policy | Carries Knowledge Runtime + Recommendation projection versions |
| Career Intelligence | Career-Intelligence-refreshed | Career Outcome Intelligence Engine, AI Context Generation | Ordered per student | Re-publishing an equivalent projection is a no-op | Rebuildable from Decision projection history + `DerivedSignalComputed` history | Both consumers degrade to last-known-good rather than fail outright | Retried with backoff; escalates on persistent failure | At least as long as both consumers' replay windows | Carries Decision projection version + Derived Signal version(s) |
| Career Outcome Intelligence Engine | Outcome-Intelligence-updated | (No named consumer in this catalogue today; reserved for future runtimes) | Ordered per batch run | Keyed on batch run ID | Rebuildable by re-running the batch over the same Record Version range | N/A today | N/A today | Retained per this runtime's own reporting retention policy | Carries Career Intelligence projection version + Record Version range analyzed |
| FYUGP Intelligence | FYUGP-Match-updated | (No named consumer in this catalogue today; reserved for future runtimes) | Ordered per student | Re-publishing an equivalent match is a no-op | Rebuildable from Academic Context history | N/A today | N/A today | Retained per this runtime's own policy | Carries Academic Context Version |
| AI Context Generation | AI-Context-generated | (Terminal — consumed by prompt-assembly components outside this WP's scope) | Ordered per student/request, depending on bundle scope | Keyed on generation ID; re-delivery is a no-op | Must reproduce an equivalent bundle for an identical set of upstream versions | Downstream AI-facing features must treat a missing/failed generation as "context not available," never substitute a stale bundle silently | Retried with backoff; escalates on persistent failure | Retained per this runtime's own policy, informed by whatever downstream AI features require for audit | Carries every upstream version consumed — the most provenance-dense event in the chain |

**Cross-cutting rules, binding on every runtime above:**
- **Ordering** is required only where a runtime's own internal state is order-sensitive (e.g. Context Version monotonicity); request-scoped, stateless runtimes (Recommendation, Decision) have no cross-request ordering requirement, matching WP-ARCH-01C's own treatment of order-independent vs. order-dependent event families.
- **Idempotency** is mandatory everywhere: every runtime must treat re-delivery of an event it has already processed as a no-op, never as a duplicate action, directly extending WP-ARCH-01C Part 11's idempotency discipline into the runtime layer.
- **Event versioning** follows WP-ARCH-01C Part 14 rule 5 unchanged: additive-only extension, new event name for anything genuinely incompatible.
- **Dead-letter strategy**: any event that fails processing after retry with backoff is not silently dropped — it surfaces to the Observability Architecture (Part 9) as a health signal, and the consuming runtime falls back to its last-known-good state rather than blocking indefinitely, except where the runtime is inherently request-scoped, in which case the request itself fails visibly rather than hanging.

---

## PART 6 — Runtime Context Assembly

| Context | Inputs | Transformation | Ownership | Consumers | Versioning | Explainability |
|---|---|---|---|---|---|---|
| Academic Context | E-01–E-08 | Compose the full current academic picture of one student (WP-ARCH-01C Part 3, E-10) | Academic Context Composition Context (domain-owned) | Student Context Runtime, FYUGP Intelligence | Context Version, monotonic per profile | Rebuildable from source events; every field traceable to a source entity/event |
| Student Context | Academic Context + sibling-domain projections | Merge academic with career/professional/personalization pictures | Student Context Runtime | Knowledge Runtime | Context Version + source projection versions | Every field traceable to its source domain's projection version |
| Knowledge Context | Student Context + platform knowledge sources | Merge student picture with opportunities/market data | Knowledge Runtime | Recommendation Engine, Decision Engine, AI Context Generation | Projection version + Student Context version + knowledge-source versions | Every field traceable to Student Context or a named knowledge source |
| Recommendation Context | Knowledge Context | Score/rank options for one request | Recommendation Engine | Decision Engine | Per-request, stamped with Knowledge Context version | Every recommendation traceable to the Knowledge Context version it scored against |
| Decision Context | Knowledge Context + Recommendation Context | Apply decision logic for one request | Decision Engine | Career Intelligence | Per-request, stamped with both input versions | Every decision traceable to the exact Knowledge + Recommendation versions used |
| Career Context | Decision Context + Derived Academic Signal | Frame decision output in career-path terms | Career Intelligence | Career Outcome Intelligence Engine, AI Context Generation | Projection version + Decision Context version + signal version(s) | Every career framing traceable to the Decision Context and signal versions consumed |
| Outcome Context | Career Context + immutable Academic Record history | Longitudinal outcome analysis | Career Outcome Intelligence Engine | (reserved for future runtimes) | Batch run ID + Career Context version + Record Version range | Every outcome trend traceable to the specific Record Version range analyzed |
| FYUGP Context | Academic Context | Program-matching against qualification/stream/level | FYUGP Intelligence | (reserved for future runtimes) | Projection version + Academic Context version | Every match traceable to the Academic Context version consumed |
| AI Context | Knowledge Context + Career Context + Derived Academic Signal | Final assembly with provenance stamping | AI Context Generation | Prompt-assembly components (outside this WP's scope) | Bundle version + every upstream version consumed | The single most explainable artifact in the chain by design — this is the point furthest from source of truth, so it must carry the most complete provenance trail |

Each row in this table is a progressive enrichment, never a reinterpretation, of the row before it — consistent with Part 3.4's rule that context is only ever added, never rewritten, as it moves downstream.

---

## PART 7 — AI Context Architecture

This part governs only how AI Context Generation assembles enterprise context; it does not design prompts or LLM logic, per the WP-ARCH-01D brief's explicit constraint.

| Input | Purpose | Authority | Freshness | Trust level | Version reference | Traceability | Explainability |
|---|---|---|---|---|---|---|---|
| Academic Context (indirect, via Knowledge Runtime) | Ground the bundle in the student's actual academic record | Domain-authoritative (Student Academic Domain) | As fresh as the last `AcademicContextRefreshed` propagated through Student Context Runtime and Knowledge Runtime | Highest — directly sourced from the canonical domain | Academic Context Version, carried through every intermediate projection's own version stamp | Full: every intermediate hop (Student Context, Knowledge Runtime) preserves the originating version | Any AI-facing claim about academic facts can be traced back to a specific Academic Context Version |
| Student Context (indirect, via Knowledge Runtime) | Provide cross-domain breadth (career, professional, personalization) | Student Context Runtime-authoritative for the composition itself; each source domain remains authoritative for its own facts | As fresh as Student Context Runtime's last rebuild | High | Student Context Version | Full, per Part 6 | Cross-domain claims traceable to source-domain projection versions |
| Knowledge Runtime projection | Provide platform knowledge context (opportunities, market data) | Knowledge Runtime-authoritative for the composition | As fresh as Knowledge Runtime's last rebuild | High | Knowledge Runtime projection version | Full | Knowledge-based claims traceable to the specific knowledge-source versions merged |
| Derived Academic Signals | Provide computed stream/affinity intelligence | Derived Academic Intelligence Context-authoritative (domain-owned, WP-ARCH-01C E-09) | Per-run, `Computed Date`-stamped | High, but explicitly marked as **derived**, never conflated with entered data (WP-ARCH-01B ADR-08) | Signal version, keyed per computation run | Full — each signal traceable to its computing engine version and source-context version | Any AI-facing claim sourced from a signal must be presentable as "this was computed, by what, from what" |
| Career Intelligence projection | Provide career-path framing of the decision outcome | Career Intelligence-authoritative for its own composition; Decision Engine remains authoritative for the underlying decision | As fresh as Career Intelligence's last rebuild | High | Career Intelligence projection version + Decision projection version consumed | Full | Career-framing claims traceable to the exact Decision output framed |

**Design principle:** every input to AI Context Generation must arrive with enough version metadata that a downstream question of the form "why does the AI think X" can be answered by walking backward through this table without needing to inspect any runtime's internal logic — the bundle is a provenance manifest as much as it is a content payload.

---

## PART 8 — Enterprise Runtime Contracts

Conceptual business contracts only — no APIs, no payload shapes.

| Provider | Consumer | Business contract | Expected information | Ownership | Consistency guarantee | Version compatibility | Failure behaviour | Retry expectation |
|---|---|---|---|---|---|---|---|---|
| Student Academic Domain | Student Context Runtime | "I will tell you every time this student's academic picture changes, and I will always be able to reconstruct it from scratch." | Academic Context, in full | Domain owns the contract's content | Eventually consistent, event-driven | Additive-only (WP-ARCH-01C Part 14 rule 5) | Domain-side failures are the domain's own governance concern, out of this WP's scope | Domain-owned |
| Student Context Runtime | Knowledge Runtime | "I will give you one coherent cross-domain student picture, versioned, whenever any contributing domain changes." | Student Context, in full | Student Context Runtime | Eventually consistent | Additive-only | Knowledge Runtime serves last-known-good on failure | Retry with backoff; escalate to Part 9 health model on persistent failure |
| Knowledge Runtime | Recommendation Engine | "I will give you everything the platform currently knows that's relevant to this student, and tell you what version it is." | Knowledge Runtime projection | Knowledge Runtime | Eventually consistent for the standing projection; strongly consistent within a single request's lifetime (the projection does not change mid-computation) | Additive-only | Recommendation Engine fails the request visibly if no usable projection is available, rather than guessing | Retry with backoff; escalate on persistent failure |
| Knowledge Runtime | Decision Engine (indirect, via Recommendation) | Same contract shape as above, one hop removed | Same | Knowledge Runtime | Same | Same | Same | Same |
| Recommendation Engine | Decision Engine | "For this specific request, here is my ranked output and the exact Knowledge Runtime version I computed it from." | Recommendation projection, per request | Recommendation Engine | Strongly consistent within the request | Additive-only | Decision Engine treats a missing recommendation as "not ready," never substitutes a default | Standard request retry |
| Decision Engine | Career Intelligence | "For this specific request, here is my decision, and the exact upstream versions I used." | Decision projection, per request | Decision Engine | Strongly consistent within the request | Additive-only | Career Intelligence treats a missing decision as "not ready" | Standard request retry |
| Student Academic Domain | Career Intelligence | "I will publish every computed signal, versioned and engine-stamped, and you may read it directly since it's already a governed publication surface." | Derived Academic Signal (E-09) | Domain owns the signal; Career Intelligence owns its own consumption cadence | Eventually consistent, event-driven | Additive-only (new signal types, never redefinitions — WP-ARCH-01C Part 11) | Career Intelligence degrades gracefully, marking career framing as signal-stale | Retry with backoff |
| Career Intelligence | Career Outcome Intelligence Engine | "I will give you a versioned career-framed picture whenever the underlying decision changes." | Career Intelligence projection | Career Intelligence | Eventually consistent | Additive-only | Career Outcome Intelligence Engine's batch run simply picks up the latest available version at run time | No real-time retry needed given the batch cadence |
| Student Academic Domain (Performance Context) | Career Outcome Intelligence Engine | "I will let you read committed/amended Academic Records directly, in Record Version order, because they're immutable — this is the sole documented direct-history exception." | Committed Academic Record history | Domain owns the data; Career Outcome Intelligence Engine owns the analysis | Strongly consistent as of the Record Version range analyzed | Superset-compatible extension only (WP-ARCH-01C Part 11, E-05 row) | Batch run defers to next cycle on failure | Batch-level retry |
| Student Academic Domain | FYUGP Intelligence | "I will give you Academic Context directly, since your inputs are purely academic and don't need cross-domain composition." | Academic Context | Domain owns the projection | Eventually consistent, event-driven | Additive-only | FYUGP Intelligence serves last-known-good match on failure | Retry with backoff |
| Knowledge Runtime, Career Intelligence, Student Academic Domain (signals) | AI Context Generation | "I will give you my current, versioned output whenever it changes, and you are responsible for stamping full provenance across all of us in your bundle." | Knowledge Runtime projection, Career Intelligence projection, Derived Academic Signal | Each provider owns its own content; AI Context Generation owns assembly | Eventually consistent per input; the bundle itself declares which version of each input it assembled | Additive-only per input; a breaking bundle-shape change is AI Context Generation's own versioning concern, not its providers' | AI Context Generation marks the bundle as partial/degraded if any one input is unavailable, rather than silently omitting it | Retry with backoff; escalate on persistent failure |

---

## PART 9 — Observability Architecture

### 9.1 Runtime tracing and correlation

Every cross-runtime interaction in this catalogue carries a correlation identifier that originates at the point a student-facing action first enters the chain (e.g. an onboarding step, a recommendation request) and is propagated unchanged through every subsequent event and projection consumption, all the way to AI Context Generation's final bundle. This is what makes it possible to answer "show me everything that happened for this one request" as a single trace, rather than reconstructing it after the fact from independent runtime logs.

### 9.2 Lineage

- **Context lineage:** Academic Context → Student Context → Knowledge Runtime projection, each hop preserving the version of the hop before it (Part 6).
- **Decision lineage:** Recommendation projection version + Knowledge Runtime version → Decision projection version → Career Intelligence projection version, fully walkable backward from any decision to the exact inputs that produced it.
- **Recommendation lineage:** Knowledge Runtime version → Recommendation projection version, walkable backward to the exact platform-knowledge state a recommendation was computed from.
- **AI lineage:** every version consumed by AI Context Generation (Part 7), the single densest lineage record in the system, by design.
- **Projection lineage:** every projection in Part 4 declares its source projection versions; a rebuild always states which source versions it rebuilt from.

### 9.3 Audit propagation

Audit responsibility for the domain's own entities remains with the domain (WP-ARCH-01C Part 9). At the runtime layer, audit propagation means: every log a runtime owns (Recommendation output log, Decision log, Career Intelligence's model state, Career Outcome Intelligence Engine's batch results) is itself immutable once written and carries the full upstream version stamp described in Part 6 — so an audit of "why did this recommendation/decision/career framing happen" never requires reconstructing state from scratch, only reading an already-immutable record.

### 9.4 Monitoring principles

- Every runtime publishes its own **freshness** (age of its current projection relative to the latest available source event) as a first-class health signal, not an incidental log line.
- Every runtime publishes **degraded-mode** status explicitly when serving last-known-good rather than current state (per Part 5's dead-letter fallback rule), so downstream consumers and operators can distinguish "correct and current" from "correct but stale" from "unavailable."
- No runtime is permitted to silently substitute a default or guessed value when an upstream input is unavailable — this is the runtime-layer expression of the data-honesty convention WP-ARCH-01A.2 §9 found already enforced in `StudentService` (never present a field as available unless confirmed), generalized into an architectural rule for every runtime in this catalogue (Part 10.3).

### 9.5 Health model

A runtime's health is reported at three levels: **Healthy** (serving current-version output, all upstream inputs fresh), **Degraded** (serving last-known-good output, one or more upstream inputs stale or unavailable, explicitly flagged as such to consumers), and **Unavailable** (cannot serve any output, including last-known-good — this state should propagate as a visible failure to the immediate consumer, never as silent omission).

### 9.6 Enterprise diagnostics

Because failure impact fans out asymmetrically (Part 2.3 notes Knowledge Runtime has the highest blast radius of any single runtime), the health model above must be queryable holistically across the whole chain — an operator should be able to ask "what is the current health of the entire pipeline for student X" and get the Healthy/Degraded/Unavailable status of every one of the nine runtimes in one view, not nine separate dashboards.

---

## PART 10 — Enterprise Runtime Governance

1. **Single writer rule (runtime layer).** Every projection in Part 4 has exactly one owning runtime that may publish a "refreshed" event for it; no other runtime, including a downstream consumer, may publish on its behalf.
2. **Projection ownership.** Ownership as declared in Part 2/Part 4 is binding; a future work package that wants to change which runtime owns a projection must do so as an explicit architectural decision (this document's own ADR process, Part 12), not as an incidental implementation choice.
3. **Read-model governance / data honesty.** No runtime may present a field in its output as available unless its own source is directly confirmed; unavailable or unconfirmed fields must be explicitly marked as such, never silently omitted or defaulted (generalizing WP-ARCH-01A.2 §9's `StudentService` convention domain-wide, per Part 9.4).
4. **Runtime independence.** Each runtime's internal computation logic (scoring models, matching algorithms, prompt-assembly logic downstream of AI Context Generation) is its own concern and is explicitly out of this document's scope — governance here applies only to what crosses a runtime boundary.
5. **Consumer isolation.** A failure or slowdown in one runtime must not directly cascade into a consumer's own failure where a degraded-mode fallback (Part 9.5) is possible; this bounds the blast radius described in Part 2.3 to "stale" rather than "down," wherever a last-known-good state exists.
6. **Reference-data governance.** All nine runtimes consume Academic Taxonomy reference data by version reference only (never a denormalized copy), per WP-ARCH-01C Part 14 rule 3, carried forward unchanged into the runtime layer.
7. **Taxonomy propagation.** A Taxonomy Version publish propagates through Academic Context → Student Context → Knowledge Runtime → every downstream runtime as a version-compatible, additive change only (WP-ARCH-01C Part 14 rules 5, 7) — no runtime in this catalogue is exempted from this discipline.
8. **Context version governance.** Every context in Part 6 carries a monotonically increasing version per the entity it composes from; a runtime that cannot state which version it is currently serving is not compliant with this architecture.
9. **Event governance.** Every event in Part 5 is a past-tense business fact, additive-only in its shape evolution, exactly as WP-ARCH-01C Part 14 rule 5 and rule 10 already establish at the domain layer — this document does not introduce a separate naming or versioning convention for runtime-layer events; it is the same convention, applied one layer further out.
10. **Replay governance.** Every projection in Part 4 must be genuinely reconstructable from its declared source events — a projection that depends on hidden state, a manual correction, or an untraceable input is not compliant, directly extending WP-ARCH-01C Part 14 rule 6.
11. **Backward compatibility.** A projection or event-shape change at any layer must never invalidate a downstream consumer's ability to correctly interpret data it already consumed — every historical record at every layer carries the specific upstream version it was produced against, precisely so later evolution cannot retroactively corrupt its meaning (WP-ARCH-01C Part 14 rule 7, restated for the runtime chain).
12. **Runtime evolution rules.** A runtime may add new optional output fields without breaking downstream consumers. Removing or repurposing an existing output field, or changing which upstream runtime a given runtime is permitted to consume from, is a breaking change requiring a new WP-ARCH-01D-level architectural decision — this document is not authorized to make that call unilaterally in a future revision, mirroring WP-ARCH-01B Part 14 rule 4's treatment of aggregate evolution.
13. **Future runtime onboarding.** A new runtime joining this landscape must: (a) declare its position in the chain (which existing runtime's output it consumes), (b) never be granted direct access to a domain aggregate or an upstream runtime's internal state — only to a declared projection or one of the two already-justified direct-signal exceptions, (c) publish its own refresh event using the same additive-only, past-tense-fact convention as every existing runtime, and (d) be added to Part 2's catalogue and Part 9's holistic health view before being considered production-eligible. No future runtime is permitted to negotiate a third direct-access exception beyond the two already justified in WP-ARCH-01B Part 8 without a dedicated ADR making the case as rigorously as ADR-06 originally closed the first ungoverned path.

---

## PART 11 — Runtime Sequence Architecture

### 11.1 Student onboarding → AI Context

1. Student completes onboarding steps → Student Onboarding issues commands to the Student Academic Domain.
2. Domain establishes the academic profile, publishing `AcademicProfileEstablished` and related events → Academic Context (E-10) is composed for the first time.
3. Student Context Runtime consumes `AcademicContextRefreshed`, merges in sibling-domain projections → publishes Student Context.
4. Knowledge Runtime consumes the Student Context refresh, merges in platform knowledge → publishes Knowledge Runtime projection.
5. On a recommendation request, Recommendation Engine consumes the current Knowledge Runtime projection → publishes a recommendation-completed signal with its output.
6. Decision Engine consumes that signal plus the Knowledge Runtime projection → publishes a decision-completed signal.
7. Career Intelligence consumes the decision-completed signal, plus any available Derived Academic Signal → publishes Career Intelligence projection.
8. AI Context Generation consumes the Knowledge Runtime projection, Career Intelligence projection, and Derived Academic Signal → assembles and publishes the AI Context bundle, fully version-stamped back to step 2.

**Every transition above is either an event consumption or a projection read — no step in this sequence involves a runtime reaching past its declared input (Part 2), and no step introduces a synchronous call chain that would couple every runtime's availability to every other runtime's uptime.**

### 11.2 Academic record updated → AI Context regenerated

1. Student (via Onboarding) or an authorized process commits/amends an Academic Record → domain publishes `AcademicRecordCommitted`/`AcademicRecordAmended`.
2. Academic Context is refreshed (new Context Version) → `AcademicContextRefreshed` fires.
3. Student Context Runtime rebuilds Student Context on this event.
4. Knowledge Runtime rebuilds its projection on the Student Context refresh.
5. The next recommendation/decision request recomputes against the now-current Knowledge Runtime projection (Recommendation Engine and Decision Engine do not proactively recompute a standing "current recommendation/decision" — they are request-scoped, per Part 2.4–2.5).
6. Career Intelligence rebuilds on the new decision-completed signal, or independently on a fresh `DerivedSignalComputed` if the Academic Record change also triggered signal recomputation in the Derived Academic Intelligence Context.
7. Career Outcome Intelligence Engine picks up the change on its next batch cycle, reading the newly committed/amended record directly (its one justified direct-history path).
8. AI Context Generation regenerates its bundle on the next of any of its three trigger signals, now reflecting the updated record end-to-end.

### 11.3 Taxonomy version published → compatibility verification

1. Academic Taxonomy Context publishes a new `TaxonomyVersionPublished` event (domain-owned, WP-ARCH-01C Part 11).
2. Academic Context validates against the new version — per WP-ARCH-01C Part 14 rule 7, existing historical entities remain valid against their originally-recorded Taxonomy Version; only new writes are affected.
3. Academic Context projection refresh is triggered where a student's data intersects the changed taxonomy entries.
4. Knowledge refresh propagates the same way as in 11.2, steps 3–4.
5. Recommendation compatibility: Recommendation Engine's next request simply uses the refreshed Knowledge Runtime projection — no special compatibility step is needed because the taxonomy change already arrived pre-resolved through Academic Context (this is exactly why WP-ARCH-01B ADR-05 keeps taxonomy resolution centralized rather than per-consumer).
6. Decision compatibility: same reasoning — Decision Engine consumes already-resolved projections, never raw taxonomy codes.
7. AI compatibility verification: AI Context Generation's bundle simply carries the new Taxonomy Version transitively through whichever upstream projection changed; no separate taxonomy-specific verification step exists at this layer, by design, since centralizing resolution at the domain layer (ADR-05) is precisely what removes the need for nine independent verification steps.

---

## PART 12 — Architectural Decision Records (ADR)

### ADR-R01: The runtime chain is a strict pipeline with exactly two documented direct-access exceptions, and no more

- **Decision:** Carry forward WP-ARCH-01B Part 8's two exceptions (Career Intelligence → Derived Academic Signal; Career Outcome Intelligence Engine → immutable Academic Record history) unchanged, and grant no new exceptions at the runtime-integration layer, including for FYUGP Intelligence's direct Academic Context read (which is a parallel branch, not a chain-skip, since FYUGP Intelligence has no other position in the named chain to skip from).
- **Alternatives considered:** Allow each new runtime to negotiate its own direct-access shortcut where convenient (e.g. letting AI Context Generation read Academic Context directly instead of via Knowledge Runtime, for "simplicity").
- **Evidence basis:** WP-ARCH-01A.2 §7.3 is the concrete, already-realized cost of allowing this kind of shortcut once.
- **Business justification:** every additional exception is one more place a future refactor of an upstream runtime can silently break a downstream consumer that was never supposed to know about that runtime's internals in the first place.
- **Long-term impact:** keeps the chain's complexity linear in the number of runtimes, not combinatorial.
- **Operational impact:** slightly more integration ceremony for AI Context Generation (three inputs instead of one); accepted, since this runtime is explicitly the one most in need of provenance discipline (Part 7).
- **AI impact:** directly protects the "AI Context Generation must never re-derive facts, only assemble already-governed ones" principle.
- **Trade-offs:** none material beyond the ceremony already noted.

### ADR-R02: Recommendation Engine and Decision Engine are request-scoped, not standing-projection runtimes

- **Decision:** Neither runtime maintains a continuously-refreshed "current recommendation" or "current decision" for a student; both recompute per request against whatever Knowledge Runtime projection is current at request time.
- **Alternatives considered:** Maintain a standing, eagerly-refreshed recommendation/decision per student, refreshed on every upstream event like Student Context Runtime and Knowledge Runtime do.
- **Repository evidence:** `RecommendationService`'s constructor-enforced dependency pattern (WP-ARCH-01A.2 §7.2) is consistent with a per-call service, not a standing cache, and nothing in the evidence suggests a background refresh loop exists or is needed.
- **Business justification:** recommendations and decisions are inherently answers to a specific question asked at a specific moment; eagerly maintaining a "current" answer for every student regardless of whether anyone asked wastes computation the platform's own AI-native, scalability-focused principles (WP-ARCH-01D brief, Architecture Principles) argue against.
- **Long-term impact:** keeps these two runtimes horizontally scalable by request volume rather than by student population size.
- **Operational impact:** simpler failure model — a failed request is simply retried, with no standing state to reconcile.
- **AI impact:** every recommendation/decision is naturally and automatically stamped with the exact upstream version current at the moment it was asked for, which is exactly the provenance guarantee Part 6/7 require.
- **Trade-offs:** a burst of near-simultaneous requests recomputes independently rather than sharing one cached answer; acceptable, and mitigated by ordinary request-level caching if ever needed, which is an implementation concern, not an architectural one.

### ADR-R03: Knowledge Runtime is the single highest-blast-radius runtime, and is governed accordingly

- **Decision:** Knowledge Runtime's health is elevated to its own explicit monitoring priority (Part 9.6) rather than being treated as one of nine equally-weighted runtimes.
- **Alternatives considered:** Treat all nine runtimes as operationally equivalent in the observability model.
- **Repository evidence:** the evidence-confirmed dependency chain (WP-ARCH-01A.2 §7.1–7.2) already shows Recommendation Engine depending on it exclusively; this document's own catalogue (Part 2.3) shows five of the remaining six runtimes depend on it directly or transitively.
- **Business justification:** an observability model that doesn't reflect actual blast radius will under-alert on the one failure mode that matters most and over-alert on the eight that matter least.
- **Long-term impact:** as future runtimes are onboarded (Part 10.13), this runtime's centrality will likely only grow, making this decision more, not less, relevant over time.
- **Operational impact:** justifies investing disproportionately in Knowledge Runtime's own resilience (caching, graceful degradation) relative to leaf runtimes like FYUGP Intelligence or Career Outcome Intelligence Engine.
- **AI impact:** protects AI Context Generation's two indirect inputs (via Knowledge Runtime) from a single point of failure taking down the whole bundle.
- **Trade-offs:** none — this is a monitoring-emphasis decision, not a structural one; it changes no runtime's contract, only how seriously its health is watched.

### ADR-R04: This document's evidence-status labeling in Part 2 is a governance artifact, not commentary

- **Decision:** every runtime's catalogue entry explicitly states whether it is evidence-confirmed or prospective, and this labeling is retained in future revisions of this document until superseded by a dedicated implementation audit.
- **Alternatives considered:** present all nine runtimes uniformly, as if equally real, for document tidiness.
- **Repository evidence:** WP-ARCH-01A.2 §12 already drew this exact distinction at the semantic-investigation layer; erasing it at the architecture layer would silently discard a finding the organization already paid to establish.
- **Business justification:** an implementation team reading this document needs to know which of the twelve contracts they are retrofitting onto working code (Student Context Runtime, Recommendation Engine) versus which they are building from a specification with no prior art (the remaining seven) — conflating these risks under-scoping the latter as if it were "just wiring up an existing service."
- **Long-term impact:** the next work package (implementation) can be sequenced and estimated honestly.
- **Operational impact:** none directly; this is a documentation-discipline decision.
- **AI impact:** none directly.
- **Trade-offs:** none.

---

## Constraints Compliance Statement

This document does not redesign WP-ARCH-01B's bounded contexts or WP-ARCH-01C's logical entities; every reference to `AcademicContext`, `DerivedAcademicSignal`, `AcademicRecord`, and the domain's events, projections, and governance rules is a citation of those documents' own Parts, not a restatement or reinterpretation. No SQL, APIs, repositories, services, RPCs, event payload schemas, or message schemas are specified anywhere above — every contract, event, and projection is described at the conceptual/business level only, per the WP-ARCH-01D brief's constraints.
