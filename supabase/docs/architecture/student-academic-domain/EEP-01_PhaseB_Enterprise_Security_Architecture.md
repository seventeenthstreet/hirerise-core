# EEP-01 — Phase B
## Enterprise Security Architecture
### Canonical Student Academic Domain

**Role:** Chief Enterprise Security Architect deliverable.
**Inputs treated as authoritative evidence (not redesigned here):** WP-ARCH-01A, WP-ARCH-01A.2, WP-ARCH-01B (Canonical Domain Architecture), WP-ARCH-01C (Enterprise Logical Data Model), WP-ARCH-01D (Enterprise Runtime Integration Architecture), WP-ARCH-01E (Enterprise Migration Strategy), WP-ARCH-01F (Architecture Closure Review), and EEP-01 Phase A (Enterprise Physical Data Model).
**Constraint compliance:** this document contains no SQL, no DDL, no PostgreSQL code, no Supabase RLS policies, no functions, triggers, repositories, services, or APIs. Every entity, context, runtime, and event named in the approved architecture appears here only as the *subject* of a security control, never as a redesign of its data or domain shape.

**Relationship to WP-ARCH-01C Part 10 (Permission Model):** WP-ARCH-01C already established a conceptual, entity-level permission model (owner/read/write/delete per entity) as part of the logical data model. This document does not repeat that table; it **absorbs it as evidence**, extends it into a full enterprise security architecture (identity, authentication, RLS isolation architecture, column-level protection, runtime/AI/service authorization, audit, privacy, threat modeling, and governance), and is the document Phase D implementation must follow. Where this document and WP-ARCH-01C Part 10 overlap, this document is authoritative for security decisions; WP-ARCH-01C remains authoritative for entity/attribute shape.

---

# PART 1 — Enterprise Security Vision

## 1.1 Security philosophy

The Canonical Student Academic Domain exists to feed ten downstream AI and runtime systems (Student Context Runtime, Knowledge Runtime, Recommendation Engine, Decision Engine, Career Intelligence, Career Outcome Intelligence Engine, FYUGP Intelligence, Academic Recommendation Engine, AI Context Generation, and future capabilities) with a single, trustworthy academic truth about a minor or young-adult student population, across multiple countries, over a ten-year data horizon. Three facts drive every decision in this document:

1. **The subject population is predominantly minors.** Class 8–12 students are, in most jurisdictions this platform targets, children. Every security control defaults to the more protective posture wherever "student" and "minor" could mean different things, rather than assuming adult norms.
2. **The data is permanently retentive by design.** WP-ARCH-01B/01C made academic history append-only and immutable specifically so ten years of trend data can be trusted. A security architecture for data that is never overwritten must be stricter about *who can read it* than one for data that ages out — there is no "it'll be deleted eventually" backstop.
3. **The consumers are increasingly autonomous.** Nine of the ten consumers are engines and AI systems, not humans clicking through a UI. Authorization for a human role and authorization for a service identity are structurally different problems, and this document treats them as such throughout (Part 3, Part 9, Part 10).

The philosophy that follows from these three facts: **assume every request is untrusted until proven otherwise (Zero Trust), grant exactly what a request needs and nothing else (Least Privilege), never rely on a single control to hold (Defense in Depth), and make every access — human or machine — explainable after the fact (Immutable Audit, Explainable AI).** Security is not layered onto the canonical domain after the fact; it is expressed through the same bounded contexts, aggregates, and single-writer rules WP-ARCH-01B already established, because a domain with one owner per concept is also a domain with one place to enforce access per concept.

## 1.2 Trust boundaries

| Boundary | Inside | Outside | Why it is a boundary |
|---|---|---|---|
| **Student trust boundary** | The authenticated student's own academic record | Every other student's record | The single most important boundary in the system; a violation here is the platform's worst-case incident (Part 13, T-01). |
| **Human/Service boundary** | Authenticated human identities (students, administrators) acting under session-based authentication | Service identities (bounded-context command surfaces, runtimes, engines) acting under service-to-service authentication | Human sessions can be phished, shared, or coerced; service identities cannot be socially engineered the same way but can be compromised at the infrastructure layer — the two require different authentication mechanisms and different monitoring (Part 3, Part 13 T-11). |
| **Write-side / Read-side boundary** | The single command surface each bounded context exposes for writes (per WP-ARCH-01B ADR-06) | Every projection, runtime, and AI system, which may only read | This is the same boundary WP-ARCH-01B already drew for domain integrity; Part 7 makes it a security boundary as well as an architectural one. |
| **Domain / Taxonomy boundary** | The Academic Taxonomy Context's publish process | Every consumer of reference data | Taxonomy governs meaning for every student's history simultaneously; an unauthorized change here corrupts explainability for the whole platform at once, not one student (Part 13, T-08). |
| **Domain / AI boundary** | Academic Context (E-10) and Derived Academic Signal (E-09), as published, version-stamped surfaces | Any LLM, prompt, or inference process | AI systems must never reach behind these surfaces to raw write-side entities — the exact violation WP-ARCH-01A.2 found `recommendation-engine.js` committing (Part 9, Part 10). |
| **Platform / External partner boundary** | HireRise's own runtimes and services | Any future external partner, integrator, or institution | Not yet instantiated, but named in the brief as a future identity (Part 3.11); the boundary is designed now so no implicit trust is ever granted by omission later. |
| **Country / Region compliance boundary** | Data subject to one jurisdiction's rules | Data subject to another's | Multi-country deployment (Part 12) means a security boundary can also be a legal boundary — the two are designed together, not layered separately. |

## 1.3 Security domains

Nine security domains are defined and detailed in Part 2: Identity, Academic (the canonical domain itself), Reference Data, Runtime, AI, Administration, Observability, Audit, and Integration. Each is scoped to match the bounded-context and runtime catalogue WP-ARCH-01B/01D already established — this document does not introduce a parallel decomposition, it applies a security lens to the existing one.

## 1.4 Security goals

1. No entity defined in WP-ARCH-01C (E-01–E-10, R-01–R-16) is ever readable or writable outside the access rules defined in Parts 6–9 of this document.
2. Every read by an AI, recommendation, decision, or career-intelligence system is traceable to a specific, version-stamped projection — never to a raw write-side row.
3. Every write, by any actor, produces an immutable audit event sufficient to reconstruct "who changed what, when, and under what authority" without inference.
4. A security or privacy incident affecting one student's data is contained to that student by default (row-level isolation), and a compromise of one service identity is contained to that service's declared scope (least privilege).
5. The architecture can onboard a new country, a new runtime, or a new AI capability without a redesign of this document — only an extension of its tables, per the same additive-only discipline WP-ARCH-01C Part 14 already established for the data model.

## 1.5 Threat assumptions

This document assumes, conservatively:

- Any client application (student-facing app, admin console) can be compromised, spoofed, or run by a malicious actor pretending to be a legitimate student or administrator.
- Any single service credential can eventually leak, be misconfigured, or be over-scoped by implementation error.
- Any LLM-facing prompt can be the target of injection, and any LLM output can be hallucinated; security cannot rely on the model behaving correctly.
- Insider access (an administrator, or an engineer with production access) is a real threat vector, not a hypothetical one, given the sensitivity of academic and, potentially, minor-status data.
- Regulatory requirements differ by country and will change over the platform's ten-year horizon; the architecture must not hard-code any single jurisdiction's rules into its structure.

## 1.6 Security principles

Zero Trust, Least Privilege, Defense in Depth, Single Source of Truth, Data Ownership, Need-to-Know, Privacy by Design, Security by Default, Immutable Audit, Explainable AI, Enterprise Governance, Multi-country Compliance, and Future Extensibility — as named in the brief — are not treated as a checklist here. Each is mapped to a concrete mechanism in the parts that follow: e.g. Least Privilege → Part 9's per-runtime allowed/forbidden operation lists; Explainable AI → Part 10's provenance-stamping requirement; Single Source of Truth → the reuse of WP-ARCH-01B's single-writer rule as this document's own authorization rule (Part 4.7).

## 1.7 Architectural justification

Security architecture is derived from, not imposed on, the canonical domain for one reason: WP-ARCH-01A.2 found the platform's *only* prior security failure mode was architectural, not procedural — `recommendation-engine.js` read six raw tables directly because no canonical composition layer existed to stop it (WP-ARCH-01B §2.5, §7.3, ADR-06). The single highest-leverage security decision available to this document is therefore not a new control bolted on top, but the enforcement, as a security rule, of the read/write separation WP-ARCH-01B already designed for data-integrity reasons. Every part of this document that follows either (a) formalizes an access rule already implied by the domain design, or (b) adds a control the domain design does not itself provide (identity, authentication, encryption, audit retention, privacy/compliance, threat response).

---

# PART 2 — Security Domain Model

| Domain | Purpose | Responsibilities | Protected assets | Trust boundary | Consumers | Producers |
|---|---|---|---|---|---|---|
| **Identity Domain** | Own the answer to "who or what is making this request" for every human and service actor | Authenticate, issue and revoke credentials, manage credential lifecycle for all identity classes (Part 3) | Credentials, session tokens, service keys, identity records | Human/Service boundary (1.2) | Every other domain (identity is a dependency of all authorization) | Authentication process (Part 3.12) |
| **Academic Domain** | The canonical Student Academic Domain itself (E-01–E-10) as approved in WP-ARCH-01B/01C | Enforce ownership, RLS isolation (Part 7), column protection (Part 8) at the data layer | Every entity in WP-ARCH-01C Parts 2–3 | Write-side/Read-side boundary | Composition Context, Derived Intelligence Context, the ten downstream runtimes (read-only) | The five bounded-context command surfaces (Identity, Performance, Cognitive & Activity, Composition, Derived Intelligence Contexts) |
| **Reference Data Domain** | Govern the Academic Taxonomy Context (R-01–R-16) as a security-relevant shared kernel | Taxonomy stewardship, version publication, deprecation governance (Part 14) | R-01–R-16, Taxonomy Version | Domain/Taxonomy boundary | Every bounded context and every downstream runtime | Taxonomy stewardship role only |
| **Runtime Domain** | The nine-runtime consumer chain (Student Context Runtime → ... → AI Context Generation, per WP-ARCH-01D) | Enforce read-only, projection-only access; propagate provenance (Part 9) | Every projection in WP-ARCH-01C Part 12 | Domain/AI boundary (for the AI-adjacent runtimes) | Downstream runtimes, end-user-facing outputs | Academic Context, Derived Academic Signal |
| **AI Domain** | AI Context Generation and every LLM-facing process | Prompt-context assembly governance, sensitive-data filtering, inference logging, explainability (Part 10) | Assembled AI context bundles, inference logs | Domain/AI boundary | End-user-facing AI content | Knowledge Runtime, Career Intelligence, Derived Academic Signal |
| **Administration Domain** | Human administrative access to the platform | Elevated read/correction rights, separation of duties, privilege-escalation prevention (Part 4) | Same protected assets as Academic Domain, plus platform configuration | Human/Service boundary (administrator sub-case) | N/A (a consumer of every domain, not a producer to any) | Administrator identity issuance (Part 3.2) |
| **Observability Domain** | Cross-runtime tracing, lineage, monitoring (per WP-ARCH-01D Part 9, extended here for security telemetry) | Correlation-ID propagation, health/degraded-mode signaling, anomaly detection inputs | Traces, health signals, freshness metadata | Integration boundary | Security governance process (Part 14), incident response (Part 13) | Every runtime and bounded context |
| **Audit Domain** | The immutable record of every security-relevant event across every other domain | Audit event schema, retention, tamper resistance, investigation support (Part 11) | Audit log itself | A boundary unto itself — the audit domain must be inaccessible for write by anything it audits | Security review process, investigations, compliance reporting | Every other domain (audit is a universal producer relationship) |
| **Integration Domain** | Cross-domain and future external-partner integration (per WP-ARCH-01B Part 8, WP-ARCH-01D Part 8) | Contract-level trust enforcement, future partner onboarding governance (Part 3.11) | Cross-domain contracts, partner credentials (future) | Platform/External partner boundary | Future partner integrations | Integration governance process (Part 14) |

---

# PART 3 — Identity Architecture

## 3.1 Student identity

- **Authentication responsibility:** the platform's identity domain, not any individual bounded context. A student authenticates once per session; every subsequent command to the Student Academic Identity, Performance, or Cognitive & Activity Contexts carries that authenticated identity, never a re-derived or assumed one.
- **Identity ownership:** the student owns their own identity record; no bounded context in the Academic Domain creates or mutates student identity — they only reference it (matching WP-ARCH-01C's "owner: the student" column, Part 10, for E-01 through E-08).
- **Credential lifecycle:** issued at account creation (external to this domain), rotated/re-authenticated per the platform's session policy, revoked immediately on account closure or a confirmed compromise, with revocation propagating to every active session, not just new ones.
- **Trust relationship:** a student identity is trusted only for its own record (Part 6, Part 7's Student Isolation rule) — a student identity is never sufficient authorization to read or write any other student's data, under any circumstance, including shared devices or family/guardian access (Part 12.9).
- **Minor-specific handling:** because most students are minors, the student identity itself carries no independent authority to grant a third party (parent, guardian, counselor) access — any such access is a distinct, explicitly-provisioned identity (administrative or a future guardian identity class) with its own audit trail, never an extension of the student's own session.

## 3.2 Administrator identity

- **Authentication responsibility:** the identity domain, with mandatory strong authentication (Part 14.2) given the elevated read/correction rights administrators hold.
- **Identity ownership:** administrators are provisioned by a separate administrative governance process (Part 14), never self-registered.
- **Credential lifecycle:** time-bounded provisioning tied to employment/role status; immediate revocation on role change or offboarding; periodic re-certification (Part 14.4) rather than indefinite standing access.
- **Trust relationship:** administrative access is read-plus-correction only, per WP-ARCH-01C Part 10's per-entity administrative column, and every correction requires a mandatory Change Reason (WP-ARCH-01C Part 9.1) — an administrator identity is never granted the ordinary student write path, only the amendment path, and only with elevated audit classification.

## 3.3 Internal service identity

- Every bounded-context command surface (Identity Context, Performance Context, Cognitive & Activity Context, Composition Context, Derived Intelligence Context, Academic Taxonomy Context) has its own distinct service identity — this is a direct security expression of WP-ARCH-01B's single-writer rule: if only one service identity is ever credentialed to write to an entity, "single writer" becomes enforceable, not just documented.
- Service identities authenticate via non-human credential mechanisms (service-to-service authentication, out of scope for this document's implementation detail, but the identity boundary is: no service identity is ever a shared human account, and no service credential is ever embedded in a client-facing application).

## 3.4 Runtime identity

Each of the nine runtimes catalogued in WP-ARCH-01D Part 2 (Student Context Runtime, Knowledge Runtime, Recommendation Engine, Decision Engine, Career Intelligence, Career Outcome Intelligence Engine, FYUGP Intelligence, AI Context Generation, and Academic Recommendation Engine if distinct) is issued its own distinct, read-only service identity, scoped to exactly the projections and direct-read exceptions WP-ARCH-01B Part 8/WP-ARCH-01D Part 8 name for it — never a shared "runtime" identity that would make one runtime's compromise equivalent to all nine.

## 3.5 Recommendation Engine identity

Scoped to read Knowledge Runtime's projection only (per WP-ARCH-01B Part 8); explicitly forbidden from holding any credential capable of reading Student Academic Domain entities directly (Part 9.4).

## 3.6 Decision Engine identity

Scoped to read Recommendation Engine and Knowledge Runtime outputs only; same direct-access prohibition as 3.5.

## 3.7 Career Intelligence identity

Scoped to read Decision Engine output and Derived Academic Signal (E-09) directly — the one named exception in WP-ARCH-01B Part 5 step 12 — with the direct-read scope limited specifically to E-09, never extended to E-01–E-08 by implication.

## 3.8 Career Outcome Intelligence Engine identity

Scoped to read Career Intelligence output and immutable Academic Record (E-05/E-06) history directly — the second and last named exception (WP-ARCH-01B Part 5 step 13). This identity's credential must be structurally incapable of write access to E-05, since the justification for the exception (immutability makes direct read safe) does not extend to write.

## 3.9 FYUGP Intelligence identity

Scoped to read Academic Context (E-10) directly, per WP-ARCH-01B Part 8 — no exception beyond the projection.

## 3.10 AI Runtime identity (AI Context Generation)

Scoped to read Knowledge Runtime projection, Career Intelligence projection, and Derived Academic Signal directly (WP-ARCH-01D Part 7) — this is the single highest-provenance-density identity in the system and is treated as such in Part 10's governance.

## 3.11 Background job identity

Any batch/periodic process (e.g. Career Outcome Intelligence Engine's batch recompute, WP-ARCH-01D Part 12) is issued a distinct identity from that runtime's request-time identity where the two run under different operational conditions, so a compromised batch credential cannot be used to make request-scoped calls with a human session's apparent urgency, and vice versa.

## 3.12 Future external partner identity

Not yet instantiated. Designed now so no implicit trust is granted by omission: a future partner identity (a) is provisioned only through the Integration Domain's governance process (Part 14.10), (b) is scoped by explicit contract to specific projections only — never to any Academic Domain write-side entity or raw taxonomy publish rights, (c) is time-bounded and re-certified on the same cadence as administrator identities (3.2), and (d) is fully auditable under the same Audit Domain rules as every internal identity (Part 11) — no partner integration is exempt from audit by virtue of being external.

## 3.13 Authentication responsibility, ownership, and lifecycle — summary rule

No bounded context, runtime, or engine implements its own authentication. Authentication is a single, centralized Identity Domain responsibility (Part 2); every other domain consumes an already-authenticated identity and is responsible only for *authorization* against it (Part 4). This separation is itself a security control: it means a bypass in one bounded context's authorization logic cannot also grant a forged identity, because the identity was never that context's to issue.

---

# PART 4 — Authorization Model

*Conceptual only. No SQL.*

## 4.1 Role hierarchy

```
Platform Root Governance (security ownership, Part 14.1)
 └─ Administrative Role (Part 3.2)
     └─ Taxonomy Steward Role (publish/deprecate R-01–R-16 only, Part 14.3)
     └─ Support/Correction Role (read + amendment, no taxonomy rights)
 └─ Student Role (Part 3.1) — scoped strictly to own record, no hierarchy above "self"
 └─ Service Role family (Part 3.3–3.12), each a sibling, none senior to another
     └─ Bounded-context command-surface identities (write-capable, one per context)
     └─ Runtime/engine identities (read-only, one per runtime)
     └─ Background job identities (scoped per job)
     └─ Future partner identities (scoped per contract)
```

No role in the Service Role family is senior to another — this is deliberate. WP-ARCH-01B's single-writer rule means no service identity ever needs to act "on behalf of" another; a hierarchy among service identities would only create an unnecessary escalation path.

## 4.2 Permission hierarchy

Permissions compose from three independent dimensions, never inferred from role alone: **Resource** (which entity, Part 5/6) × **Operation** (Part 4.4) × **Scope** (own-record / all-records / context-owned). A permission is only valid if all three are explicitly granted; there is no "administrator implies all permissions" shortcut, precisely to keep Part 4.8's escalation-prevention rule enforceable.

## 4.3 Resource hierarchy

Mirrors WP-ARCH-01C Part 2's entity catalogue exactly: Operational (E-01, E-02) → Historical (E-03–E-08) → Derived (E-09) → Projection (E-10) → Reference (R-01–R-16). Permission grants are scoped at this granularity, never at a coarser "the domain" level, so that a future entity added under WP-ARCH-01C Part 14 rule 4 inherits no permission by default — it must be explicitly added to Parts 6/9's matrices before any identity may access it.

## 4.4 Operation hierarchy

Read < Create < Update < Delete/Archive < Restore, with **Amendment** (Part 6.6) modeled as a distinct operation from Update — an amendment is never granted implicitly by an Update permission, because Update on a Historical-layer entity should not exist at all (Part 6.6, Part 7.2).

## 4.5 Ownership hierarchy

The student is always the business owner of their own E-01–E-08 records (WP-ARCH-01C Part 10's "Owner" column, restated). System/computation processes own E-09; the Composition Context owns E-10 as sole producer; the Taxonomy stewardship role owns R-01–R-16. Ownership determines who *may be granted* access by default (Part 6), not who automatically has it — even the student's own default access is mediated through the bounded-context command surface, never a direct grant to raw storage.

## 4.6 Delegation rules

No student identity may delegate access to their own record to another student identity, under any circumstance. The only delegation path in this domain is administrative: a support/correction role may be granted time-bounded, audited access to a specific student record for a specific investigation or correction (Part 3.2), never a standing delegation. No service identity may delegate its credential to another service identity — each of the nine runtime identities (3.4) must present its own credential on every call, never a borrowed one.

## 4.7 Inheritance rules

A child entity (Part 5/WP-ARCH-01C Part 3) inherits its parent aggregate's access scope by default (e.g. Subject Performance, E-06, inherits Academic Record's, E-05, scope) — this mirrors WP-ARCH-01C's own aggregate-boundary design and avoids a second, independent permission decision for every child entity. Inheritance is one-directional (parent → child); a child entity's access is never broadened independently of its parent.

## 4.8 Privilege escalation prevention

1. No role or identity may grant itself a permission it does not already hold — all grants originate from the Platform Root Governance process (Part 14.1), never from a self-service mechanism.
2. Administrative correction rights (Part 3.2) never imply taxonomy publish rights, and taxonomy steward rights never imply student-record correction rights — these are deliberately disjoint, per Part 4.9's separation of duties.
3. A service identity that is compromised can never be used to obtain a *different* service identity's credential — each identity's credential material is isolated per WP-ARCH-01B ADR-06's single-writer boundary, made a security boundary here.
4. No runtime identity (3.4–3.10) may be upgraded, at runtime, to a write-capable identity — this distinction is fixed at provisioning time, never negotiated by a request.

## 4.9 Separation of duties

- The Taxonomy Steward role (publish/deprecate reference data) is held distinct from every operational administrative role — no single identity holds both, because a taxonomy change affects every student simultaneously while an operational correction affects one (Part 13, T-08 vs. T-01 have different blast radii and should never share an approver).
- Security governance (Part 14.1) is held distinct from Administration Domain (Part 2) day-to-day operation — the people who define access rules are not, by default, the people who exercise elevated access under them, enabling meaningful review (Part 14.9).
- Audit Domain access (Part 11) is held distinct from every domain it audits — no identity that can write to the Academic, Reference Data, or Administration domains may also modify the audit log describing its own actions.

## 4.10 Administrative boundaries

Administrative access is bounded to **read + amendment**, never to the ordinary student-write command surface (Part 3.2), and every amendment is subject to the same Change Reason and elevated Audit Classification WP-ARCH-01C Part 9.1 already requires. Administrative access to a specific student's record should default to being justified by a specific, logged reason (a support ticket, an investigation) rather than standing, unscoped visibility into the full student population — see Part 7.3's administrative isolation model for the row-level expression of this boundary.

---

# PART 5 — Data Classification

Every logical entity from WP-ARCH-01C Parts 2–3 (Phase A physical model reflects the same catalogue) is classified below.

| Classification | Entities | Protection level | Encryption requirement | Access requirement | Retention expectation | Audit requirement |
|---|---|---|---|---|---|---|
| **Public Reference** | Portions of R-01–R-14 that are non-sensitive published taxonomy (country/board/subject names, etc.) | Baseline | In transit only | Universal read (Part 2, Reference Data Domain) | Permanent (WP-ARCH-01C Part 9.3) | Publish/deprecate events only |
| **Internal Reference** | R-15 (Board–Region Map), R-16 (Taxonomy Version), and any taxonomy metadata not intended for direct external/partner exposure | Elevated | In transit and at rest | Every bounded context and downstream runtime; external partners only via explicit contract (Part 3.12) | Permanent | Publish/deprecate events |
| **Confidential** | E-01 (Student Academic Profile), E-02 (Language Preference), E-03 (Academic Qualification), E-04 (Subject Selection) | High | At rest and in transit | Student (own record), owning bounded context, Composition Context; no direct AI/Recommendation/Decision access (WP-ARCH-01C Part 10) | Indefinite, governed by platform account-level policy (WP-ARCH-01C Part 9.3) | Every create/update event |
| **Sensitive** | E-05 (Academic Record), E-06 (Subject Performance) — academic results, which in most jurisdictions and for a minor population carry heightened sensitivity | Highest (non-derived) | At rest and in transit; field-level protections per Part 8 | Student (own record, while draft), owning bounded context, Composition/Derived Intelligence Context, Career Outcome Intelligence Engine (justified exception only) | Indefinite, append-only, never deleted | Commit and amendment events, elevated classification |
| **Restricted** | E-07 (Cognitive Assessment Result) — psychometric/cognitive data | Highest | At rest and in transit; strictest column-level protection (Part 8) | Student (own record), owning context, Composition/Derived Intelligence Context only — no administrative override without documented cause given the psychometric nature of this data | Indefinite | Creation event, elevated classification |
| **System** | Service identities, credentials, taxonomy stewardship configuration | High | At rest and in transit | Identity Domain and Platform Root Governance only | Per credential lifecycle (Part 3) | Every issuance/revocation event |
| **Derived** | E-09 (Derived Academic Signal) | Elevated | At rest and in transit | Recommendation, Decision, Career Intelligence, AI Context Generation (read-only, version-referenced, WP-ARCH-01C Part 10) | Retained for explainability of past decisions even after superseded (WP-ARCH-01C Part 9.3) | Creation event only (immutable) |
| **Audit** | The Audit Domain's own log (Part 11) | Highest | At rest and in transit; tamper-evidence required (Part 11.9) | Security review/investigation process only; no domain that is audited may write to its own audit trail | Longest in the system — retained beyond the entities it describes wherever legally required (Part 12) | N/A — is itself the audit mechanism |
| **AI Context** | E-10 (Academic Context) and every downstream projection in WP-ARCH-01C Part 12 | Elevated | At rest (where persisted for replay) and in transit | The nine named downstream runtimes only, read-only, always version-stamped (WP-ARCH-01C Part 10) | Only as long as operationally useful for replay (WP-ARCH-01C Part 9.3) — shorter than source data, since fully rebuildable | Rebuild events, source-version stamped |
| **Activity/Extracurricular** | E-08 (Activity Record) | Confidential | At rest and in transit | Student (own record), owning context, Composition Context | Indefinite, append-only | Creation/withdrawal/correction events |

---

# PART 6 — Access Matrix

For every canonical entity, extending WP-ARCH-01C Part 10 with the four additional access classes the security brief requires (Knowledge Runtime Read, Student Context Runtime Read, Background Job Read, and an explicit Archive/Restore column). "—" denotes no access under any circumstance.

| Entity | Owner | Read | Create | Update | Delete | Archive | Restore | AI Read | Recommendation Read | Decision Read | Knowledge Runtime Read | Student Context Runtime Read | Administrative Read | Service Read | Background Job Read |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| E-01 Profile | Student | Student (own); Composition Context | Identity Context | Identity Context | — | Account-level only (external) | Account-level only | — (via E-10 only) | — (via E-10 only) | — (via E-10 only) | — (via E-10 only) | Via E-10 | Yes, + correction | Identity Context command surface | — |
| E-02 Language Preference | Student | Same as E-01 | Identity Context | Full-set replace, Identity Context | — | Withdrawal via full-set replace | — | — | — | — | — | Via E-10 | Yes, + correction | Identity Context | — |
| E-03 Qualification | Student | Student (own); Composition Context; Performance Context (validate anchoring); Career Outcome Intelligence Engine (justified exception) | Identity Context | Status-transition only | — | Discontinuation only | — | — | — | — | — | Via E-10 | Yes, + status correction | Identity Context | Career Outcome batch (justified exception) |
| E-04 Selection | Student | Student (own); Composition Context; Performance Context (E-06 validation) | Identity Context | Add/withdraw only | — | Withdrawal only | — | — | — | — | — | Via E-10 | Read only | Identity Context | — |
| E-05 Academic Record | Student | Student (own, draft only); Composition Context; Derived Intelligence Context; Career Outcome Intelligence Engine (immutable history, justified exception) | Performance Context | Draft-state only | — | — | — | — (via E-10/Derived only) | — | — | — | Via E-10 | Read only, amendment = elevated audit | Performance Context | Career Outcome batch (justified exception) |
| E-06 Subject Performance | Student | Same as E-05 | Performance Context | Draft-state only | — | — | — | — | — | — | — | Via E-10 | Read only | Performance Context | Same as E-05 |
| E-07 Cognitive Result | Student | Student (own); Composition Context; Derived Intelligence Context | Cognitive & Activity Context | — | — | — | — | — | — | — | — | Via E-10 | Read only, no override (Part 5) | Cognitive & Activity Context | — |
| E-08 Activity Record | Student | Student (own); Composition Context | Cognitive & Activity Context | Supersession only | — | Withdrawal only | — | — | — | — | — | Via E-10 | Read only | Cognitive & Activity Context | — |
| E-09 Derived Signal | System | Recommendation, Decision, Career Intelligence, AI Context Generation (all read-only, version-ref'd) | Derived Intelligence Context | — | — | — | — | Yes, version-ref'd | Yes | Yes | Yes (via Knowledge Runtime) | — | Read only | Derived Intelligence Context | — |
| E-10 Academic Context | System (Composition Context) | Student Context Runtime, Knowledge Runtime, and transitively every named consumer | Composition Context rebuild | — (rebuilt, not updated) | — | — (historical versions retained for replay) | Rebuildable at any time | Read-only, version-stamped | Read-only, indirect | Read-only, indirect | Yes | Yes | Read only | Composition Context | — |
| R-01…R-16 Reference | Taxonomy stewardship | Universal (every context, every runtime) | Taxonomy stewardship process only | Deprecation only, no in-place edit | — | Deprecation only | — (deprecation is one-way forward) | Read-only | Read-only | Read-only | Read-only | Read-only | Full publish/deprecate (steward role only) | All contexts | — |

**Permission explanations (cross-cutting, applies to every row):**
- **Owner:** the business owner of record per WP-ARCH-01C Part 10 — determines who a grant may default to, not an automatic right (Part 4.5).
- **Read:** always scoped to the identity's own record for students; always scoped to a declared projection or justified exception for every downstream system, per WP-ARCH-01B ADR-06.
- **Create/Update:** always routed through exactly one command surface per WP-ARCH-01B's single-writer rule; no entity has two legitimate write paths.
- **Delete:** structurally absent for every Historical/Derived/Reference entity (Part 6.6 amendment rule replaces it); present only at the account level for Operational entities, and even then external to this domain (WP-ARCH-01C Part 9.2).
- **AI/Recommendation/Decision/Knowledge Runtime Read:** never granted directly on E-01–E-08; only ever on E-09/E-10, enforcing WP-ARCH-01B ADR-06 and WP-ARCH-01C Part 12's "every projection is or is built from E-10" rule.
- **Background Job Read:** scoped to the two named justified exceptions only (Career Outcome Intelligence Engine's batch read of E-03/E-05 history) — no other background process is granted a standing read right in this domain.

---

# PART 7 — Enterprise RLS Architecture

*Conceptual model only. No SQL, no physical RLS policies — this defines the isolation rules Phase D's Supabase RLS must implement.*

## 7.1 Ownership rules

Row-level ownership for every Operational and Historical entity (E-01–E-08) is anchored to the student identity that the aggregate belongs to (directly for E-01/E-03/E-05/E-07/E-08, transitively via parent for E-02/E-04/E-06). No row in these entities is ever ownerless; a row without a resolvable owning student identity is a data-integrity fault, not a valid state, and must fail closed (i.e., be unreadable) rather than default to broad visibility.

## 7.2 Isolation model

Isolation is enforced at four levels, each independently:
1. **Student isolation** (7.3) — the default, most restrictive case.
2. **Administrative isolation** (7.4) — a deliberately narrower exception to student isolation.
3. **Runtime isolation** (7.5) — no isolation *by student*, because runtimes never see raw per-row data at all; isolation here is *by entity/projection*, not by row.
4. **Service isolation** (7.6) — each bounded-context command surface is isolated from every other's write path.

## 7.3 Student isolation

A student's session may only resolve rows in E-01–E-08 where the row's owning student identity matches the session's authenticated identity. This is the direct row-level expression of Part 3.1's trust relationship and Part 1.2's Student trust boundary — it is the single most heavily relied-upon rule in this architecture, and Part 13's threat model (T-01, Broken Authorization) treats any weakening of it as the platform's highest-severity risk.

## 7.4 Administrative isolation

An administrative identity's default row visibility is **narrower than "all students,"** not broader — visibility into a specific student's record should be justified by a specific case/ticket context (Part 4.10) and logged as such, rather than the administrative role carrying standing, unscoped SELECT-equivalent access to the full student population. Where a genuine operational need exists for broader read access (e.g. cohort-level reporting), that need is served by an aggregate/statistical projection, never by row-level access to individual student histories, per Need-to-Know (1.6).

## 7.5 Runtime isolation

No runtime (Student Context Runtime through AI Context Generation) ever queries E-01–E-08 by row at all — its isolation is structural, not row-filtered: it can only resolve the single projection (E-10) or the two named justified exceptions (E-09, and immutable E-05/E-03 history for Career Outcome Intelligence Engine), each already scoped to exactly one student's data per request by the request's own parameters, never a cross-student query. "Runtime isolation" in this domain therefore means *no cross-entity reach*, not *a per-row filter* — reflecting that these are service identities operating on behalf of a single student-scoped request, not standing broad-access accounts.

## 7.6 Service isolation

Each bounded-context command surface (Identity, Performance, Cognitive & Activity, Composition, Derived Intelligence, Taxonomy) is isolated from every other's write path at the credential level (Part 3.3) — the Performance Context's service identity, for example, has no credential capable of writing to Identity Context-owned entities (E-01–E-04), even though it reads some of them for validation (Part 6). Read access for cross-context validation (e.g. Performance Context reading E-04 to validate E-06) is always narrower than the owning context's own read scope and never implies write.

## 7.7 Reference-data access

R-01–R-16 are universally readable by every context and runtime (Part 6) but writable only by the Taxonomy stewardship service identity — this is the one entity family in the domain where row-level *isolation* is not the relevant control (there is no "owning student" concept for reference data); the relevant control is the write/read asymmetry itself (Part 4.9's separation of duties).

## 7.8 Historical access

Historical entities (E-03–E-08) are readable, once committed, only by the same rules as their Operational counterparts (7.3/7.4) — committed status does not broaden visibility, it only narrows *mutability* (Part 6.6). A student's own historical record remains visible to them indefinitely; it does not become administrative-only or read-only-to-others simply because it is old.

## 7.9 Audit access

The Audit Domain's own log (Part 11) is isolated from every domain it describes: no identity that can write to Academic, Reference Data, or Administration domains may read or write its own audit trail with the same credential used for those domains — audit access requires a distinct, dedicated Audit Domain identity, itself subject to Part 4.9's separation-of-duties rule.

## 7.10 Soft delete visibility

Per WP-ARCH-01C Part 9.2, no Historical or Derived entity supports deletion at all — there is therefore no "soft-deleted but administratively visible" state to design for those layers. Operational-entity retirement (E-01/E-02) happens only at the whole-account level, external to this domain; this domain's RLS model does not need its own soft-delete visibility tier because the domain itself defines none.

## 7.11 Cross-runtime visibility

No runtime may resolve another runtime's internal state or credential — cross-runtime "visibility" exists only through the declared projection chain (WP-ARCH-01D Part 4/Part 8), never through a side channel. Career Intelligence, for instance, cannot query Recommendation Engine's internal computation state; it can only consume Decision Engine's published, version-stamped output, per the existing runtime contract.

---

# PART 8 — Column-Level Protection

## 8.1 Personally identifiable information

**Fields:** identity-resolving attributes on E-01 (country/region/board/institution references), any name/contact data held outside this domain but referenced by it.
- **Protection:** encryption at rest; access limited to owning context and the student themselves.
- **Masking:** administrative views default to masked/partial display unless a specific correction task requires full visibility.
- **Encryption:** at rest and in transit, mandatory.
- **Hashing:** not applicable to PII fields requiring display; hashing is reserved for fields never needing to be shown in cleartext (8.7).
- **Redaction:** any AI-facing projection (E-10 and downstream) must redact direct identifiers before inclusion in an AI Context Generation bundle (Part 10.5) — an AI system should reason over academic facts, not over a student's identifying details, wherever the recommendation/decision task does not genuinely require them.
- **Logging:** every read of raw PII fields by an administrative identity is individually logged (not just "record accessed," but which fields).
- **Monitoring:** anomalous volume of PII-field reads by any single administrative identity is a standing detection rule (Part 13, T-02).
- **Administrative override:** permitted only with a documented Change Reason, per WP-ARCH-01C Part 9.1.

## 8.2 Sensitive academic information

**Fields:** E-05/E-06 marks, grades, percentages.
- **Protection:** encryption at rest; row-scoped per Part 7.3.
- **Masking:** not masked from the owning student; masked in any aggregate/cohort-level administrative or reporting view down to a statistical summary, never individual marks, unless the specific task is a named correction.
- **Encryption:** mandatory at rest and in transit.
- **Hashing:** not applicable — these values must remain usable/computable.
- **Redaction:** never redacted from the owning student or the Performance/Derived Intelligence/Composition contexts; redacted from any context outside this domain that does not hold a named read right (Part 6).
- **Logging:** every commit and amendment logged per WP-ARCH-01C Part 11's event model, at column-change grain for amendments (which specific values changed).
- **Monitoring:** unusual amendment frequency for a single student or by a single administrative identity is a standing detection rule (Part 13, T-03).
- **Administrative override:** amendment only, mandatory Change Reason and elevated Audit Classification (WP-ARCH-01C Part 9.1).

## 8.3 Assessment information

**Fields:** E-07 cognitive assessment scores and raw response payload.
- **Protection:** highest column-level protection in the domain (Restricted classification, Part 5) given the psychometric nature of the data and the minor-heavy population.
- **Masking:** administrative views show existence and date of an assessment by default, not the scored dimensions, unless a specific, documented need exists.
- **Encryption:** mandatory at rest and in transit; the raw response payload is treated as a discrete, separately-protected value object (per WP-ARCH-01B Part 3.5), not merged into the scored-dimensions record.
- **Hashing:** not applicable to the scores themselves; the raw payload may be additionally integrity-hashed to detect tampering, distinct from encryption.
- **Redaction:** raw response payload is never included in any AI-facing bundle — only the scored dimensions, and only where the specific downstream use case (e.g. stream affinity) genuinely requires them.
- **Logging:** creation event is the complete audit record (WP-ARCH-01C Part 3, E-07) — no update path exists to log beyond that.
- **Monitoring:** any read pattern touching cognitive results outside the Composition/Derived Intelligence Contexts is flagged (Part 13, T-04).
- **Administrative override:** explicitly **no override** without documented, elevated cause (Part 5) — this is the one entity family where this document recommends the narrowest possible administrative exception in the whole domain.

## 8.4 Behavioral information

**Fields:** E-08 activity records (extracurricular participation, achievement level).
- **Protection:** Confidential classification (Part 5).
- **Masking:** not masked from the owning student; summarized (not itemized) in cross-domain projections unless the specific downstream consumer's contract requires itemized detail.
- **Encryption:** at rest and in transit.
- **Hashing:** not applicable.
- **Redaction:** itemized activity detail redacted from AI-facing bundles in favor of a summarized signal, consistent with Part 10.5's minimization principle.
- **Logging:** creation, withdrawal, and correction events per WP-ARCH-01C Part 11.
- **Monitoring:** standard access monitoring, no elevated tier required beyond the domain baseline.
- **Administrative override:** read only (Part 6); no correction path beyond supersession, which is itself student- or system-initiated, not administrative.

## 8.5 AI-derived information

**Fields:** E-09 Derived Academic Signal values.
- **Protection:** Derived classification (Part 5); structurally distinct from user-entered data (WP-ARCH-01B ADR-08).
- **Masking:** not masked from its named consumers (Recommendation, Decision, Career Intelligence, AI Context Generation); not exposed to the student directly as raw scores without the explainability context Part 10 requires (a signal without its provenance is not meaningfully interpretable and risks misread as fact rather than inference).
- **Encryption:** at rest and in transit.
- **Hashing:** not applicable.
- **Redaction:** never redacted from its named consumers; always redacted of any raw source-entity content it might otherwise carry (a signal exposes its computed value and version references, never a copy of the E-05/E-07 data it was computed from).
- **Logging:** creation is the audit record; consumers must log which specific signal instance ID they used (WP-ARCH-01C Part 3, E-09), not merely "the latest."
- **Monitoring:** a signal being consumed without its version reference is a compliance violation of Part 10.5's traceability rule and should be a standing detection rule.
- **Administrative override:** read only; no correction path — a wrong signal is superseded by a new computation run, never edited.

## 8.6 Audit information

**Fields:** the Audit Domain's own log entries (Part 11).
- **Protection:** Audit classification (Part 5) — the highest protection tier in the system.
- **Masking:** not masked to the security review/investigation process; masked to every other domain by default (7.9).
- **Encryption:** mandatory at rest and in transit.
- **Hashing:** every audit entry additionally carries a tamper-evidence mechanism (e.g. a chained integrity value) so a modification to a past entry is independently detectable, not merely prevented by access control alone (defense in depth, 1.6).
- **Redaction:** never redacted for the investigation process; may be summarized (not redacted) for compliance reporting that does not require entry-level detail.
- **Logging:** the audit log does not log reads of itself in the same store, to avoid infinite regress, but access to the audit log is itself a Security Event (Part 11.4) recorded in a structurally separate, equally protected mechanism.
- **Monitoring:** any write attempt against the audit store from outside the designated audit-ingestion path is treated as a critical security event (Part 13, T-09).
- **Administrative override:** none. The audit log has no amendment mechanism by design — a factual correction to what was logged is itself logged as a new entry, never an edit to the original.

## 8.7 Cross-cutting: hashing use case

Where a value genuinely never needs cleartext display or computation (e.g. a device or session fingerprint used only for anomaly comparison), it is hashed rather than encrypted, since encryption implies an intended-to-be-reversed use case that does not apply. This is named here as a rule rather than applied to any specific field above, since no field catalogued in WP-ARCH-01C's Part 4 currently falls into this category — it is reserved for future extension (Part 15).

---

# PART 9 — Runtime Authorization

For every runtime named in WP-ARCH-01D Part 2, restated with an explicit allowed/forbidden operation split.

| Runtime | Allowed operations | Forbidden operations | Projection access | Direct entity access | Cache access | Administrative access |
|---|---|---|---|---|---|---|
| **Student Context Runtime** | Read Academic Context (E-10) and equivalent projections from other domains; compose Student Context | Any write to E-01–E-09; any read of E-01–E-09 not mediated by E-10 | Academic Context (E-10) | None | Read/write its own composed Student Context projection only | None — not an administrative surface |
| **Knowledge Runtime** | Read Student Context; compose Knowledge Runtime projection | Any direct read of any Academic Domain entity; any write anywhere in this domain | Student Context (indirect academic data) | None | Read/write its own projection only | None |
| **Recommendation Engine** | Read Knowledge Runtime projection, per request | Any direct read of E-01–E-10; any write | None directly (consumes Knowledge Runtime only) | None | Request-scoped only, no standing cache of student-identifiable data beyond the request | None |
| **Decision Engine** | Read Recommendation Engine and Knowledge Runtime output, per request | Same as Recommendation Engine | None directly | None | Request-scoped only | None |
| **Career Intelligence** | Read Decision Engine output; read Derived Academic Signal (E-09) directly | Any read of E-01–E-08; any write to E-09 or any other entity | Decision projection | E-09 (justified exception, Part 3.7) | May cache its own composed Career Intelligence projection | None |
| **Career Outcome Intelligence Engine** | Read Career Intelligence output; read committed Academic Record (E-05) and Qualification (E-03) history directly | Write to E-03/E-05/E-06 under any circumstance; read of E-01/E-02/E-04/E-07/E-08 directly | Career Intelligence projection | E-05, E-03 (justified exception, Part 3.8) | Batch-scoped cache only, refreshed per WP-ARCH-01D's periodic recompute cadence | None |
| **FYUGP Intelligence** | Read Academic Context (E-10) directly | Any read of E-01–E-09 directly; any write | Academic Context | None beyond E-10 | Request/refresh-scoped | None |
| **AI Context Generation** | Read Knowledge Runtime, Career Intelligence, and Derived Academic Signal (E-09) directly, per Part 10 | Any read of E-01–E-08 directly under any circumstance; any write anywhere | Knowledge Runtime, Career Intelligence | E-09 (justified exception) | Bundle assembled fresh per request, never persisted as truth (WP-ARCH-01C Part 7's "AI context" row) | None |
| **Academic Recommendation Engine** (if distinct from Recommendation Engine) | Identical boundary to Recommendation Engine | Identical | Knowledge Runtime only | None | Same as Recommendation Engine | None |

**Cross-cutting rule:** no runtime in this table is ever granted Administrative access under any circumstance — administrative correction is exclusively a human-identity path (Part 3.2, Part 4.10), never something a runtime or engine performs programmatically, even for data quality remediation. A runtime detecting a likely data-quality issue raises it through Observability (Part 2) for human administrative review; it does not self-correct.

---

# PART 10 — AI Security Architecture

*No prompts designed here — security architecture only.*

## 10.1 AI Context Generation governance

AI Context Generation is the single most sensitive service identity in the runtime chain (Part 3.10) because it is the only process permitted to assemble the final LLM-facing bundle from three separate authorized inputs (Knowledge Runtime, Career Intelligence, Derived Academic Signal — WP-ARCH-01D Part 7). Governance requires: (a) no other process may assemble an equivalent bundle — this is a single, named integration point, not a pattern any consumer may reimplement; (b) every assembled bundle is itself logged (Part 11) before being handed to any LLM; (c) assembly logic is auditable — a security reviewer must be able to answer "what could this bundle have contained" without inspecting the LLM itself.

## 10.2 LLM access

The LLM process itself holds no standing credential to any entity in this domain — it receives only the already-assembled, already-redacted bundle from AI Context Generation. This is a deliberate architectural choice: the LLM is never a first-class identity in Part 3's identity architecture, precisely because an LLM cannot be authenticated or held accountable the way a service identity can — treating the bundle hand-off as the trust boundary (rather than trusting the LLM with direct access) contains the blast radius of prompt injection (10.6) to "what was in the bundle," never "what the domain contains."

## 10.3 Prompt context (security boundary only)

The security-relevant property of prompt context is not its wording (out of scope, per the brief) but its **provenance completeness** — every fact in the bundle must be traceable to a specific input version per WP-ARCH-01D Part 7's table. A bundle that cannot state which Academic Context version, Derived Signal version, and Career Intelligence version it drew from is not compliant with this architecture, regardless of how well-written the resulting prompt is.

## 10.4 Sensitive data filtering

Before any content reaches AI Context Generation's assembly step, direct identifiers (8.1), raw cognitive-assessment payloads (8.3), and itemized (rather than summarized) activity detail (8.4) are filtered out at the source projection, not at the prompt-writing stage — filtering is a property of what the Knowledge Runtime/Career Intelligence projections are allowed to contain in the first place (Part 5, Part 8), not a step AI Context Generation is trusted to remember to perform.

## 10.5 Prompt redaction / PII protection

Restated from 8.1/10.4: no direct identifier ever reaches the LLM-facing bundle unless the specific downstream capability's contract explicitly names a need for it (e.g. personalized addressing), and any such named need is itself security-reviewed (Part 14.9) before being added to a projection's allowed content.

## 10.6 Inference logging

Every LLM invocation using an AI Context Generation bundle is logged with: the bundle's full version-provenance record (10.3), a reference to which specific bundle was used (not its content re-logged in full, to avoid duplicating sensitive data into a second store unnecessarily), and the invocation's timestamp and requesting context. This is what makes 10.7/10.8 possible after the fact.

## 10.7 Hallucination traceability

Because every fact in a bundle is version-stamped to a specific source (10.3), any downstream claim that does not match its cited source version is identifiable as either (a) a hallucination, if no matching source fact exists, or (b) a stale claim, if the source has since been superseded — this distinction matters operationally (a hallucination is a model-quality issue; a stale claim is a freshness issue) and this architecture's provenance stamping is what makes the distinction answerable at all, per WP-ARCH-01D Part 7's design principle.

## 10.8 Decision provenance / recommendation provenance

Per WP-ARCH-01C Part 13's cross-domain mapping and WP-ARCH-01D Part 8's contract table, Recommendation and Decision domains are required (as a condition of consuming this domain's data at all) to record the exact Knowledge Runtime/Academic Context version they computed from — this document treats that requirement as a security control, not merely a data-quality one, because "why did the system recommend/decide X" is the operative question in any dispute, complaint, or regulatory inquiry involving a minor's academic future.

## 10.9 Explainability

The cumulative effect of 10.1–10.8 is that any AI-facing claim about a student can be walked backward, without inspecting model internals, to: the specific Academic Context version → the specific source-entity events that composed it → the specific bounded context and identity that produced those events. This is Explainable AI (1.6) made structural rather than aspirational, directly extending WP-ARCH-01D Part 7's design principle into a named security requirement.

---

# PART 11 — Audit Architecture

## 11.1 Audit ownership

The Audit Domain (Part 2) is owned by the security governance process (Part 14.1), structurally separate from every domain it audits (7.9, 8.6) — no domain audits itself.

## 11.2 Audit events

Every event named in WP-ARCH-01C Part 11's Enterprise Event Model (`AcademicProfileEstablished`, `QualificationStarted`, `AcademicRecordCommitted`, `AcademicRecordAmended`, `TaxonomyVersionPublished`, etc.) is, from this document's perspective, also an audit event — this document does not define a second, parallel event catalogue; it requires that every domain event already carry the audit attributes WP-ARCH-01C Part 9.1 specifies (Created By, Created At, Change Reason where applicable, Business Event, Version, Audit Classification) and be additionally retained in the Audit Domain's own protected store (8.6), not only in the domain's own operational store.

## 11.3 Security events

Authentication failures, authorization denials, and credential lifecycle changes (issuance, rotation, revocation — Part 3) are logged as a distinct Security Event category, always including the identity attempted, the resource attempted, and the reason for denial where applicable.

## 11.4 Authentication events

Every login, session establishment, and re-authentication for every identity class in Part 3 is logged, including failed attempts, with enough detail to support the anomaly detection referenced in Part 13 (e.g. impossible-travel or credential-stuffing patterns) without logging the credential material itself.

## 11.5 Authorization events

Every authorization decision that results in a denial (an identity attempting an operation outside its Part 4/6/9 scope) is logged as a discrete event — not merely as an application error — since a pattern of denied attempts is itself a security signal (Part 13, T-01/T-02) distinct from any single denial.

## 11.6 Data access events

Every read of Confidential, Sensitive, or Restricted-classified data (Part 5) by any identity other than the owning student is logged individually, per 8.1's field-level logging requirement, extended here to all three classifications.

## 11.7 Administrative events

Every administrative read (Part 4.10) and every amendment (Part 6.6) is logged with the mandatory Change Reason and elevated Audit Classification WP-ARCH-01C Part 9.1 already requires — this document adds the requirement that administrative *read* access, not only write/amendment, be logged, since read-access-only misuse (e.g. browsing student records without cause) is itself a real risk for a minor-heavy population (Part 13, T-02).

## 11.8 AI events

Per Part 10.6, every AI Context Generation bundle assembly and every LLM invocation using it is logged, with full version provenance.

## 11.9 Recommendation events / Decision events

Per Part 10.8, every Recommendation and Decision output is logged with its consumed input versions, satisfying both this document's provenance requirement and WP-ARCH-01D Part 9.3's runtime-layer audit-propagation rule.

## 11.10 Retention

Audit data is retained at least as long as the longest-retained entity it describes (which, given WP-ARCH-01C Part 9.3's indefinite retention for Operational/Historical/Derived data, is effectively permanent for most audit categories), and longer where a specific jurisdiction's regulatory retention period (Part 12) exceeds the domain's own default.

## 11.11 Tamper resistance

Per 8.6, every audit entry carries an independently verifiable integrity mechanism, and the audit store itself is write-isolated from every domain it describes (7.9). A tamper attempt against a past entry must be detectable even if the attacker holds a credential otherwise capable of writing to the audit-ingestion path.

## 11.12 Investigation support

The audit log must be queryable, for the security review process (Part 14.9), by student identity, by service identity, by time range, and by Business Event type — sufficient to reconstruct, for any specific incident, exactly which identities touched exactly which entities, in what order, matching WP-ARCH-01D Part 9.1's correlation-ID propagation carried through to the audit layer.

---

# PART 12 — Privacy & Compliance

*Implementation agnostic.*

## 12.1 Multi-country deployment

The Academic Taxonomy Context's country/region layering (WP-ARCH-01B Part 6) is also this document's compliance layering mechanism: because taxonomy — not schema — varies by country, compliance rules that are country-specific (retention length, consent mechanism, data-residency expectation) can be attached to a Country/Region reference entity (R-01/R-02) rather than requiring a schema change per jurisdiction, mirroring the same extensibility principle WP-ARCH-01B already established for taxonomy generally.

## 12.2 Data minimization

Every projection in WP-ARCH-01C Part 12 is required, by this document, to carry only the fields its named consumers' contracts (WP-ARCH-01D Part 8) actually specify — a projection is not permitted to carry a superset of fields "in case a future consumer needs them." This directly extends Part 10.4's AI-specific filtering rule into a domain-wide minimization principle.

## 12.3 Purpose limitation

Each of the ten named downstream consumers is scoped (Part 9) to the specific projection or exception its stated purpose requires; a runtime may not be repurposed to consume a broader projection without the same architectural-decision process WP-ARCH-01D Part 10.12/WP-ARCH-01B Part 14.4 already require for any boundary change.

## 12.4 Retention

Restated from WP-ARCH-01C Part 9.3 and Part 11.10 here as a compliance control, not only a data-model one: retention defaults to indefinite for Historical/Derived data (justified by the platform's stated ten-year explainability horizon) but must be capable of being shortened per-jurisdiction where a specific country's law requires it — this is designed as a per-Region compliance attribute (12.1), not a change to the domain's default architecture.

## 12.5 Deletion / right to erasure

Because E-03–E-09 are architecturally append-only and immutable (WP-ARCH-01B ADR-04), "erasure" in this domain cannot mean in-place deletion of a historical record without breaking the explainability guarantee every downstream AI decision depends on (Part 10.9). Where a jurisdiction's right-to-erasure obligation applies, this document recommends the mechanism be **cryptographic erasure or identity-unlinking** (rendering a specific student's historical rows permanently unresolvable to their identity, e.g. by destroying the key material that would otherwise re-link them) rather than row deletion — preserving aggregate/statistical and Derived-signal integrity for other students while honoring the individual erasure right. This is a policy recommendation for Phase D's implementation, not a schema change to WP-ARCH-01C.
- **Minor-specific note:** erasure requests concerning a student who was a minor at the time data was collected should default to the most permissive (student-favorable) interpretation available under the applicable jurisdiction, given the special protection minors' data warrants (1.1, 12.9).

## 12.6 Data portability

The Academic Context (E-10) projection is, by construction, already the single coherent representation of a student's full academic picture (WP-ARCH-01B §2.5) — this document recommends it as the natural export unit for any data-portability obligation, since exporting it requires no new composition logic beyond what the domain already produces for its own downstream consumers.

## 12.7 Consent

Consent capture and management is outside this domain's scope (it belongs to the Student Onboarding / account-level domain, per WP-ARCH-01B Part 8's "Onboarding is a producer, not a consumer" boundary), but this domain's write commands (Identity, Performance, Cognitive & Activity Context command surfaces) should require, as a precondition, that the calling context has already confirmed valid consent — this domain does not itself verify consent, but it is designed to refuse writes if the upstream system does not assert it, keeping the boundary clean per WP-ARCH-01B's existing ownership split.

## 12.8 Minor/student protection

Given that most students are minors: (a) no field in this domain is ever exposed to a third-party marketing or advertising use case, full stop; (b) any future guardian/parental-access identity class (not yet defined) must be provisioned with its own distinct identity and audit trail (Part 3.1), never as an extension of the student's own session; (c) Restricted-classified data (E-07, cognitive assessment) receives the narrowest administrative-override policy in the entire domain (8.3) specifically because of the psychometric/minor-data intersection.

## 12.9 Sensitive academic records

E-05/E-06 (marks/grades) and E-07 (cognitive results) are treated, throughout this document, as the two most protected data families in the domain (Part 5) — this reflects that academic and psychometric records about a minor are, in most of the jurisdictions this platform is likely to operate in, subject to the strictest available protection category under applicable education- and child-data-privacy law, even where this document does not name a specific statute (12.10).

## 12.10 Cross-border considerations

Where a student's data may need to be processed or stored in a different country than the student's own (e.g. centralized AI processing), this document recommends that country/region-scoped compliance attributes (12.1) explicitly capture any data-residency or cross-border-transfer restriction as taxonomy-governed metadata on the relevant Region/Country reference entity, so that a future implementation can enforce "do not process this student's data outside Region X" as a declarative rule rather than a hard-coded exception — remaining, as instructed, implementation-agnostic about the specific enforcement mechanism.

---

# PART 13 — Threat Model

| ID | Threat | Likelihood | Impact | Mitigation | Detection | Recovery |
|---|---|---|---|---|---|---|
| **T-01** | Broken authorization / student isolation failure (a student or attacker reads another student's record) | Low (with Part 7.3 enforced), but highest-impact if it occurs | Critical — direct breach of minors' sensitive academic/psychometric data | Row-level student isolation (7.3) enforced independently of application logic (defense in depth); no service identity ever bypasses it | Authorization-denial event monitoring (11.5); anomalous cross-student access pattern detection | Immediate credential/session revocation (Part 3.1), incident disclosure per Part 14.9's process, affected-student notification per applicable law (Part 12) |
| **T-02** | Privilege escalation (administrative or service identity obtains broader access than granted) | Low | High — could expose the full student population, not one student | Part 4.8's escalation-prevention rules; separation of duties (4.9); no self-service grants | Grant-change audit review (11.7); unexpected scope-widening in a service identity's credential | Immediate revocation of the escalated grant; governance review of how it was issued (Part 14.9) |
| **T-03** | Data leakage via an over-broad AI-facing projection | Medium (the single confirmed historical failure mode, WP-ARCH-01B §7.3) | High — direct violation of Part 10's redaction/minimization rules | Source-projection filtering (10.4), never prompt-stage filtering; minimization principle (12.2) | Bundle-content audit sampling (11.8); a bundle containing a field outside its named contract is itself a detectable compliance violation | Revoke/patch the offending projection's field list; re-issue affected AI Context Generation bundles going forward; review historical bundle logs for exposure extent |
| **T-04** | Inference attacks (deriving E-07/E-05 sensitive facts from supposedly-aggregated or derived outputs) | Medium, given ten downstream AI/analytics consumers | Medium-High, particularly for cognitive assessment data (8.3) | Derived-signal structural separation (Part 5, ADR-08); summarization rather than itemization in cross-domain projections (8.4, 8.3) | Monitoring for unusual read patterns against Derived Intelligence outputs correlated with attempts to reconstruct individual-level detail (8.3) | Tighten the relevant projection's aggregation granularity; security review of the specific derived-signal design |
| **T-05** | Prompt injection against AI Context Generation or downstream LLM processes | Medium-High (a known, evolving attack class against any LLM-integrated system) | Medium — contained by design, since the LLM holds no standing credential (10.2) | LLM holds no direct entity access (10.2); bundle is pre-filtered before assembly (10.4); every claim is provenance-stamped so an injected/fabricated claim lacking a valid source reference is identifiable (10.7) | Traceability check (10.7) flags any output claim without a matching source version | Discard the affected output; do not act on any unprovenanced claim; review the specific prompt-assembly path for the injection vector (out of this document's scope to design, but in scope to detect) |
| **T-06** | Projection poisoning (a compromised or buggy source event corrupts the Academic Context projection for one or many students) | Low-Medium | High if undetected, since ten downstream systems trust E-10 | Projection rebuild is always fully reconstructable from source events (WP-ARCH-01C Part 14 rule 6); source events are themselves immutable/append-only | Freshness and rebuild-consistency monitoring (WP-ARCH-01D Part 9.4/9.5); a rebuild producing a materially different result from a prior replay of the same event range is a detectable anomaly | Replay the affected student's (or all students') projection from the immutable event history, per WP-ARCH-01B Part 7's replay guarantee |
| **T-07** | Reference-data tampering (unauthorized taxonomy modification) | Low, given Part 7.7's write isolation | High — corrupts explainability/meaning for every student simultaneously, not one | Single Taxonomy stewardship service identity (3.3, 7.7); separation from every other administrative role (4.9) | Any write attempt against R-01–R-16 from outside the Taxonomy stewardship identity is a critical, immediately-alerted event | Roll back to the last valid Taxonomy Version (R-16, which is itself immutable/append-only, so a rollback is a new forward publish, not an edit); review steward-role credential integrity |
| **T-08** | Unauthorized taxonomy modification — treated distinctly from T-07 where the actor is a legitimate steward acting outside proper governance process | Low | High — same blast radius as T-07 but harder to detect since the credential itself is legitimate | Change-review requirement for taxonomy publishes (Part 14.3); separation of duties preventing a single steward from both proposing and approving a publish | Governance-process audit trail (11.2) showing publish events without a corresponding review record | Governance review and, if warranted, revocation of steward status; publish a corrective Taxonomy Version |
| **T-09** | Audit manipulation (an attempt to alter or delete audit history) | Low, given 7.9/8.6's write isolation | Critical — undermines every other control's ability to be verified after the fact | Structural write isolation of the Audit Domain from every domain it describes (7.9); tamper-evidence mechanism (8.6, 11.11) | Any write attempt against the audit store outside the designated ingestion path is itself a critical Security Event (11.3) | Restore from the tamper-evident record; treat the incident as a top-severity governance escalation (Part 14.9) regardless of what else it enabled |
| **T-10** | Insider threats (an administrator or engineer with legitimate elevated access misuses it) | Medium — the most realistic threat vector for a platform holding minors' academic/psychometric data | High | Least-privilege administrative scoping (4.10, 7.4); mandatory Change Reason and elevated audit classification for every correction (11.7); read-access logging, not just write (11.7) | Pattern-based monitoring of administrative read/correction volume and scope over time (11.7); periodic access re-certification (Part 14.4) surfaces standing access that should be narrowed | Immediate access revocation; governance review; case-by-case notification assessment depending on what was actually accessed |
| **T-11** | Service compromise (a service identity's credential is stolen or a service is compromised at the infrastructure layer) | Medium over a ten-year horizon | High, but contained by design to that one bounded context's declared scope (single-writer rule, 4.8.3) | Per-context, non-shared service identities (3.3); no credential delegation (4.6); scoped, non-standing credentials for background jobs (3.11) | Anomalous request volume/pattern from a single service identity (Observability Domain, Part 2) | Immediate credential rotation/revocation for the affected identity only — the isolation design (4.8.3) means this does not require rotating every other identity |

---

# PART 14 — Security Governance

1. **Security ownership.** A named security governance function (distinct from day-to-day Administration Domain operation, per Part 4.9) owns this document, approves any deviation from it, and is the escalation point for every threat in Part 13.
2. **Key management principles.** Encryption keys (Part 8) are managed independently of the data they protect, rotated on a defined cadence, and never shared across bounded-context service identities (3.3) — a key compromise in one context must not imply compromise in another.
3. **Secret management principles.** Service credentials (3.3–3.12) are provisioned through a dedicated secrets-management process, never embedded in client-facing code or configuration checked into a shared repository, and rotated on compromise or on the same cadence as administrative re-certification (14.4).
4. **Identity lifecycle.** Every identity class in Part 3 has a defined provisioning, rotation, and revocation process; administrative and future-partner identities (3.2, 3.12) are additionally subject to periodic re-certification — standing access is reviewed, not assumed to remain appropriate indefinitely.
5. **Role governance.** Changes to the role hierarchy (Part 4.1) or any role's permission grant require the same architectural-decision-record discipline WP-ARCH-01B/01D already apply to aggregate/runtime boundary changes (WP-ARCH-01B Part 14.4, WP-ARCH-01D Part 10.12) — this document extends that discipline to security-relevant changes specifically.
6. **Permission governance.** The Access Matrix (Part 6) is the single source of truth for entity-level permissions; any Phase D implementation detail that would grant an access not listed there is out of compliance with this architecture and must be corrected, not grandfathered.
7. **RLS governance.** Changes to the isolation model (Part 7) — e.g. broadening administrative visibility, or narrowing student isolation for a new use case — require explicit security governance sign-off before Phase D implements them, given Part 13 T-01's severity.
8. **Reference-data governance.** Per 7.7/4.9/13 T-07/T-08, taxonomy publish rights remain with a single, separately-governed steward role, with change review as a mandatory precondition for publish, not merely a best practice.
9. **AI governance.** Any new AI-facing capability or projection must be security-reviewed against Part 10's provenance/minimization/redaction requirements before being added to the runtime chain — this is the enforcement mechanism for WP-ARCH-01D Part 10.13's "future runtime onboarding" rule, applied specifically to the AI-security dimension.
10. **Security review process.** Every architectural change proposed under WP-ARCH-01B Part 14.4, WP-ARCH-01C Part 14 rule 4, or WP-ARCH-01D Part 10.12/13 is reviewed against this document before approval — this document is a standing input to those governance processes, not a one-time artifact superseded once Phase D begins.
11. **Future security evolution.** New entities, runtimes, or identity classes are added to this document's Parts 3/6/9 tables additively (mirroring the additive-only discipline WP-ARCH-01C Part 14 rule 5 and WP-ARCH-01D Part 10.12 already establish for the data and runtime layers) — a breaking change to this document's own security model (e.g. removing an isolation rule) requires the same explicit, dedicated review as a breaking domain or runtime change.

---

# PART 15 — Implementation Readiness

Checklist for Phase D. Everything below is required before SQL/RLS/Supabase implementation begins.

## 15.1 Security decisions completed

- [x] Identity classes for every human and service actor defined (Part 3)
- [x] Role/permission/resource/operation hierarchy defined (Part 4)
- [x] Every WP-ARCH-01C entity (E-01–E-10, R-01–R-16) classified (Part 5)
- [x] Access matrix covering owner/CRUD/archive/restore/AI/Recommendation/Decision/Knowledge Runtime/Student Context Runtime/Administrative/Service/Background Job access defined for every entity (Part 6)
- [x] RLS isolation model — student, administrative, runtime, service — defined conceptually (Part 7)
- [x] Column-level protection defined for every sensitive field family (Part 8)
- [x] Runtime authorization (allowed/forbidden operations) defined for all nine runtimes (Part 9)
- [x] AI security governance — provenance, filtering, redaction, explainability — defined (Part 10)
- [x] Audit event catalogue and retention/tamper-resistance requirements defined (Part 11)
- [x] Privacy/compliance posture for multi-country, minor-heavy population defined (Part 12)
- [x] Threat model with mitigation/detection/recovery for eleven named threats defined (Part 13)
- [x] Governance process for ongoing security evolution defined (Part 14)

## 15.2 Outstanding assumptions

- This document assumes Phase A's Enterprise Physical Data Model can express the ownership/audit attributes named in WP-ARCH-01C Part 9.1 and this document's Part 8 at the physical layer; Phase D should confirm no physical-model gap exists before implementing RLS against it.
- This document assumes a distinct, non-shared credential mechanism is available per service identity (Part 3.3–3.12); Phase D must confirm the chosen secrets-management tooling supports this granularity before implementation, per Part 14.3.
- This document assumes cryptographic erasure/identity-unlinking (12.5) is technically feasible within the chosen storage platform; Phase D should validate this specifically, since it is a recommendation, not a guaranteed mechanism.
- Guardian/parental-access identity (12.8) is named as a future consideration only; no such identity is designed here, and none should be implemented without a dedicated extension to Part 3 and this document's governance review (Part 14.9).
- Specific regulatory regimes per target country (e.g. named data-protection statutes) are deliberately not enumerated in Part 12, per the brief's "remain implementation agnostic" instruction; Phase D's legal/compliance function should map Part 12's principles to the specific laws of each launch jurisdiction before go-live in that jurisdiction.

## 15.3 Validation requirements

- Phase D must validate that every RLS policy it writes maps to exactly one row in Part 6's Access Matrix — no policy should grant an access this document does not list.
- Phase D must validate that no service identity's implemented credential scope exceeds Part 9's allowed-operations column for that runtime.
- Phase D must validate, before launch, that the audit-ingestion path is genuinely write-isolated from every domain it describes (7.9), not merely access-controlled by convention.
- Phase D must validate that AI Context Generation's implemented bundle assembly cannot, even under a bug, include a field this document's Part 8/10 redaction rules exclude — this should be tested adversarially, not assumed from code review alone, given T-03's likelihood rating (Part 13).

## 15.4 Acceptance criteria

Phase D's implementation is acceptable against this document when:
1. Every entity in WP-ARCH-01C's catalogue has an implemented access control matching Part 6 exactly — no more permissive, no less.
2. Student row-level isolation (7.3) is demonstrably unbypassable by any service identity, including administrative and runtime identities, except through the narrowly-scoped exceptions this document explicitly names.
3. Every audit event named in Part 11 is being produced and is independently verifiable as tamper-evident.
4. Every AI-facing bundle is demonstrably traceable to its source versions per Part 10.3/10.7, verified by test, not by design review alone.
5. The eleven threats in Part 13 each have an implemented, testable detection mechanism, not merely a documented mitigation.

## 15.5 Known risks

- The single largest implementation risk is T-03 (data leakage via over-broad AI-facing projection) recurring in a new form during Phase D, given it is the one confirmed historical failure mode (WP-ARCH-01B §7.3) — Phase D should treat projection-field review as a mandatory step for every runtime integration, not an optional one.
- The second risk is administrative over-scoping (T-02, T-10) being implemented more broadly than Part 4.10/7.4 specify, for operational convenience, during a time-constrained implementation phase — governance review (Part 14.9) should specifically check for this before launch.
- The third risk is that cryptographic erasure (12.5) proves technically harder to implement than row deletion, creating pressure to fall back to deletion in a way that would break the append-only/replay guarantees WP-ARCH-01B Part 7 relies on — this trade-off should be resolved explicitly by governance (Part 14), not by default during implementation.

---

# STOP CONDITION — Phase B Deliverables

## 1. Executive Summary

This document is the Enterprise Security Blueprint for the Canonical Student Academic Domain. It takes the bounded contexts, aggregates, single-writer rule, and event model already approved in WP-ARCH-01B/01C/01D as given, and applies a complete security lens to them: identity and authentication for every human and service actor (Part 3); a conceptual role/permission/resource/operation authorization model (Part 4); classification of every entity in the domain (Part 5); a full access matrix (Part 6); a conceptual row-level isolation model (Part 7); column-level protection for every sensitive field family (Part 8); explicit runtime authorization for all nine downstream consumers (Part 9); AI security governance built on provenance and explainability (Part 10); an audit architecture (Part 11); privacy and multi-country compliance posture (Part 12); an eleven-threat threat model (Part 13); and a governance process for keeping this document current as the domain evolves (Part 14). The single most important security decision in this document is the one already implied by WP-ARCH-01B ADR-06 and made explicit throughout: **no runtime, AI system, recommendation engine, or decision engine ever accesses a Student Academic Domain write-side entity directly** — every one of them reads only a version-stamped projection, or one of the two narrowly-justified historical exceptions. This single rule, consistently enforced, closes the one concrete architectural risk the evidence base (WP-ARCH-01A.2 §7.3) actually found.

## 2. Security Readiness Assessment

The security architecture is **conceptually complete** against the brief's fifteen required parts. It is grounded in, and cross-referenced against, the approved WP-ARCH-01A through 01F documents and Phase A's physical data model, and introduces no redesign of any approved entity, aggregate, or runtime boundary. Every access rule in Parts 6, 7, and 9 traces to a specific ownership or consumption relationship already established in WP-ARCH-01B/01C/01D, meaning Phase D should not need to make a fresh architectural judgment call about *who may access what* — only about *how* to implement the access rules this document already specifies.

## 3. Outstanding Risks

See Part 15.5 in full. In summary: (1) risk of a new form of the platform's one confirmed historical data-leakage pattern recurring during AI/runtime implementation; (2) risk of administrative access being implemented more broadly than specified, for convenience; (3) risk that the recommended erasure mechanism (cryptographic erasure over deletion) proves harder to implement than a naive approach that would break the domain's append-only guarantees.

## 4. Phase B Validation Checklist

See Part 15.1–15.3 in full. All fifteen required security decisions are recorded as complete (15.1); five explicit outstanding assumptions are named for Phase D to confirm (15.2); four validation requirements are named for Phase D to test against, not merely review (15.3).

## 5. Phase B Acceptance Criteria

See Part 15.4 in full — five criteria, each phrased so it can be tested against Phase D's actual implementation, not merely checked against this document's prose.

## 6. Recommendation to Proceed

**Recommendation: Proceed to Phase C**, on the condition that the five outstanding assumptions in Part 15.2 are explicitly tracked as open items for Phase D (not silently assumed resolved), and that the three outstanding risks in Part 15.5 — particularly the recurrence risk for the platform's one confirmed historical data-leakage pattern — are carried forward as named risks in Phase C/D planning rather than considered closed by this document alone.

---

*End of EEP-01 Phase B. Awaiting approval before proceeding to Phase C.*
