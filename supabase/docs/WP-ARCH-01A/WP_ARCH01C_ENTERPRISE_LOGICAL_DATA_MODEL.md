# WP-ARCH-01C — Enterprise Logical Data Model
## Canonical Student Academic Domain

**Status:** Translates the approved WP-ARCH-01B architecture into a logical data model. WP-ARCH-01B's bounded contexts, aggregate boundaries, and ownership decisions are treated as fixed and are not reconsidered here.
**Level:** Logical only. No SQL, DDL, Supabase/PostgreSQL types, indexes, RLS, triggers, RPCs, or repository/API code appear anywhere in this document. Data types below are **logical** types (Text, Number, Boolean, Date, DateTime, Enumeration, Code Reference, Identifier, Money, Percentage, Duration, Collection-of-X) — not physical column types.
**Entity ID scheme used throughout this document:** operational/derived/projection entities are prefixed `E-`; reference/taxonomy entities are prefixed `R-`. IDs are used purely to cross-reference the same entity consistently across Parts 2–14.

---

## PART 1 — Enterprise Information Model

### 1.1 Information layers

The domain's information is organized into five layers, matching WP-ARCH-01B's context/aggregate design exactly — no new layer is introduced here, only named and populated at the logical-model level:

| Layer | Definition | Mutability | Contains |
|---|---|---|---|
| **Reference data** | Shared-kernel facts that exist independent of any student, versioned as a set | Append/version only — a reference entry is deprecated, never deleted, never edited in place | Country, Region, Board, Curriculum, Program, Academic Level, Qualification Type, Stream, Subject, Language, Institution, Assessment System, Credit System, Grade System, Taxonomy Version, Board-Region Map (Part 7) |
| **Operational data** | Current, actively-maintained student-specific state | Mutable in place (current-state entities) | Student Academic Profile, Language Preference (Part 3.1–3.2) |
| **Historical data** | Immutable, append-only records of what happened | Immutable once committed; amendment creates a new linked record, never an edit | Academic Qualification, Subject Selection, Academic Record, Subject Performance, Cognitive Assessment Result, Activity Record (Part 3.3–3.8) |
| **Derived data** | Computed, versioned outputs of the domain's own history | Immutable per computation run; never user-editable | Derived Academic Signal (Part 3.9) |
| **Projection / read models** | Rebuildable compositions of the above, held for consumption only | Fully rebuildable; never independently authored | Academic Context and the eight downstream projections (Part 12) |

### 1.2 Write model vs. read model

The **write model** is the set of operational, historical, and derived entities above — these are the only entities any command may target, and each has exactly one bounded context as canonical owner (per WP-ARCH-01B Part 4). The **read model** is the Academic Context projection and everything derived from it further downstream (Student Context, Knowledge Runtime projection, etc., Part 12) — these are never write targets, only rebuilt from write-model events. This split is structural in this logical model, not a naming convention: no projection entity in Part 12 carries a "write" operation in Part 3 or Part 11.

### 1.3 Shared reference data

All reference data (Part 7) is modeled once, in the Academic Taxonomy Context, and referenced — never copied — by every operational and historical entity that needs it. A logical attribute typed **Code Reference** in Part 4 always means "a business-key code resolved against a specific Taxonomy Version," never a foreign key to an internal identifier and never a duplicated value.

### 1.4 Value objects — modeling convention

WP-ARCH-01B names several value objects (`TaxonomyReference`, `QualificationPeriod`, `Score`). At the logical-attribute level, a value object has no identity or independent lifecycle of its own, so it is **not given a separate entity ID** in this document — its fields are listed as attributes embedded within the owning entity's attribute table in Part 4, each tagged `(Value Object: <name>)` in the attribute's Business Meaning for traceability back to WP-ARCH-01B Part 3.

---

## PART 2 — Canonical Entity Catalogue

| ID | Entity | Business Purpose | Bounded Context | Aggregate | Canonical Owner | Lifecycle | Mutability | Category |
|---|---|---|---|---|---|---|---|---|
| E-01 | Student Academic Profile | Current academic identity of a student | Student Academic Identity | Root | Identity Context | Established once, updated in place | Mutable (current-state) | Operational |
| E-02 | Language Preference | A language medium/additional language the student uses | Student Academic Identity | Child of E-01 | Identity Context | Created/updated with profile | Mutable (current-state) | Operational |
| E-03 | Academic Qualification | One credential instance a student pursues/completes | Student Academic Identity | Root | Identity Context | Started → active → completed | Immutable core facts; status transitions only | Historical |
| E-04 | Subject Selection | A subject chosen for a qualification (enrollment, not result) | Student Academic Identity | Child of E-03 | Identity Context | Set at/near qualification start; may change while qualification is active | Mutable while qualification active; frozen at completion | Historical (once frozen) |
| E-05 | Academic Record | One committed period's performance envelope within a qualification | Student Academic Performance | Root | Performance Context | Draft → committed → (amended) | Immutable once committed | Historical |
| E-06 | Subject Performance | One subject's result within an Academic Record | Student Academic Performance | Child of E-05 | Performance Context | Created with/added to a draft record; frozen at commit | Immutable once parent committed | Historical |
| E-07 | Cognitive Assessment Result | One assessment attempt's scored outcome | Student Cognitive & Activity | Root | Cognitive & Activity Context | Created at assessment completion | Immutable | Historical |
| E-08 | Activity Record | One extracurricular activity entry | Student Cognitive & Activity | Root | Cognitive & Activity Context | Created when reported | Immutable | Historical |
| E-09 | Derived Academic Signal | A versioned, computed academic intelligence output (e.g. stream affinity) | Derived Academic Intelligence | Root | Derived Intelligence Context | Created per computation run | Immutable per run | Derived |
| E-10 | Academic Context | Composed, versioned projection of E-01 through E-08 | Academic Context Composition | Read model | Composition Context | Rebuilt on every relevant event | Fully rebuildable; never directly written | Projection |
| R-01 | Country | Top-level geographic/regulatory reference | Academic Taxonomy | Reference | Taxonomy Context | Published, versioned, deprecable | Append/version only | Reference |
| R-02 | Region | Sub-national area within a Country | Academic Taxonomy | Reference | Taxonomy Context | Published, versioned, deprecable | Append/version only | Reference |
| R-03 | Board | Education system/examining body | Academic Taxonomy | Reference | Taxonomy Context | Published, versioned, deprecable | Append/version only | Reference |
| R-04 | Curriculum | A defined course of study under a Board | Academic Taxonomy | Reference | Taxonomy Context | Published, versioned, deprecable | Append/version only | Reference |
| R-05 | Program | A named program of study (e.g. undergraduate degree program) | Academic Taxonomy | Reference | Taxonomy Context | Published, versioned, deprecable | Append/version only | Reference |
| R-06 | Academic Level | A stage within a Curriculum (e.g. "Class 10", "Year 2") | Academic Taxonomy | Reference | Taxonomy Context | Published, versioned, deprecable | Append/version only | Reference |
| R-07 | Qualification Type | The category of credential a Qualification instance (E-03) represents | Academic Taxonomy | Reference | Taxonomy Context | Published, versioned, deprecable | Append/version only | Reference |
| R-08 | Stream | A subject-grouping specialization within an Academic Level | Academic Taxonomy | Reference | Taxonomy Context | Published, versioned, deprecable | Append/version only | Reference |
| R-09 | Subject | An academic subject | Academic Taxonomy | Reference | Taxonomy Context | Published, versioned, deprecable | Append/version only | Reference |
| R-10 | Language | A language (medium of instruction or studied language) | Academic Taxonomy | Reference | Taxonomy Context | Published, versioned, deprecable | Append/version only | Reference |
| R-11 | Institution | A specific school/college/university | Academic Taxonomy | Reference | Taxonomy Context | Published, versioned, deprecable | Append/version only | Reference |
| R-12 | Assessment System | A defined evaluation methodology (e.g. exam-based, continuous) | Academic Taxonomy | Reference | Taxonomy Context | Published, versioned, deprecable | Append/version only | Reference |
| R-13 | Credit System | A defined academic-credit scheme | Academic Taxonomy | Reference | Taxonomy Context | Published, versioned, deprecable | Append/version only | Reference |
| R-14 | Grade System | A defined grading scale (letter grades, GPA, percentage bands) | Academic Taxonomy | Reference | Taxonomy Context | Published, versioned, deprecable | Append/version only | Reference |
| R-15 | Board-Region Map | Which Boards operate in which Regions | Academic Taxonomy | Reference (association) | Taxonomy Context | Published, versioned, deprecable | Append/version only | Reference |
| R-16 | Taxonomy Version | An immutable stamp of the reference data's state at a point in time | Academic Taxonomy | Reference (meta) | Taxonomy Context | Published, never edited | Immutable, append-only | Reference |

---

## PART 3 — Entity Definitions

Definitions are given only for the ten domain entities (E-01–E-10); reference-entity definitions are given in Part 7 to avoid duplication, per this document's own structure.

### E-01 — Student Academic Profile
- **Purpose:** the single, always-current representation of a student's academic identity.
- **Responsibilities:** hold the student's current Country/Region/Board/Institution/Academic Level/Stream references and be the anchor from which Qualifications (E-03) are started.
- **Business meaning:** answers "who is this student, academically, today."
- **Lifecycle — Creation:** established exactly once, at the start of academic onboarding, when the minimum identity facts (country, board) are known.
- **Lifecycle — Updates:** updated in place whenever the student's current context changes (e.g. moves region, changes board); each update is a full, atomic replacement of the changed fields, not a partial patch with undefined intermediate state.
- **Lifecycle — Retirement:** a profile is never retired while the student account exists; it is superseded in content, not in identity.
- **Lifecycle — Archival:** on account deletion, archival policy is inherited from the platform-wide data retention policy (outside this domain's scope); the profile itself carries no independent archival rule.
- **Versioning:** current-state only — WP-ARCH-01B Part 3.1 explicitly designs this as the one entity that does not need its own history, since qualification- and record-level entities carry the domain's history instead.
- **Audit strategy:** every update produces an audit entry per Part 9; the profile itself does not retain prior states, but the audit log does.

### E-02 — Language Preference
- **Purpose:** represent one language relationship the student has (medium of instruction, or an additional studied language).
- **Responsibilities:** distinguish medium-of-instruction languages from additional languages, and carry a proficiency indicator for additional languages.
- **Business meaning:** answers "what language(s) does this student learn in, and what else do they speak/study."
- **Lifecycle — Creation:** created alongside or shortly after the profile, as part of initial academic setup.
- **Lifecycle — Updates:** the student's language preference **set** is replaced as a whole when changed (matching the confirmed business rule in WP-ARCH-01A.2 §9 Rule 9) — individual entries are not independently patched.
- **Lifecycle — Retirement:** a language preference is retired (removed from the current set) when superseded by a new full-set replacement; it is not separately versioned.
- **Versioning:** current-state only, scoped to the owning profile.
- **Audit strategy:** each full-set replacement produces one audit entry referencing the entire prior and new sets.

### E-03 — Academic Qualification
- **Purpose:** represent one specific credential the student is pursuing or has completed.
- **Responsibilities:** own the Board/Curriculum/Stream/Institution/period applicable to this specific credential, and anchor Subject Selections (E-04) and Academic Records (E-05).
- **Business meaning:** answers "what is this specific stage of education the student is going through" — e.g. "Class 10, CBSE, 2024–25" or, in the future, a named undergraduate program.
- **Lifecycle — Creation:** created when a student begins a new stage of education; always references the Profile (E-01) it was started from and the Taxonomy Version active at creation.
- **Lifecycle — Updates:** the qualification's core identity (Board, Curriculum, period) is immutable once created; only its **status** (active → completed) may transition, and completion date may be set once.
- **Lifecycle — Retirement:** a qualification is never deleted; if abandoned without completion, its status is set to a terminal "discontinued" state rather than removed, preserving history.
- **Lifecycle — Archival:** retained indefinitely as part of the student's permanent academic history, subject to platform-wide retention policy.
- **Versioning:** a qualification does not itself have multiple versions; correction of a genuine data-entry error at creation is handled via an explicit amendment event, not a silent edit.
- **Audit strategy:** creation and every status transition is a discrete, retained event.

### E-04 — Subject Selection
- **Purpose:** represent one subject the student has enrolled in for a specific qualification.
- **Responsibilities:** declare intent/enrollment only — carries no performance data.
- **Business meaning:** answers "what is this student studying," independent of "how are they doing in it" (E-06).
- **Lifecycle — Creation:** created when the student declares subjects for an active qualification, typically before performance data exists.
- **Lifecycle — Updates:** may change while the parent qualification is active (a student can add/drop a subject); each change is recorded, not overwritten in place, so a later question of "was this student ever enrolled in Subject X" remains answerable.
- **Lifecycle — Retirement:** a selection is marked withdrawn (not deleted) if dropped; frozen permanently once the parent qualification completes.
- **Versioning:** the active set is current-state while the qualification is open; the full history of changes is retained as an ordered sequence of selection-change events.
- **Audit strategy:** every add/drop is a discrete audit event, referencing the qualification and taxonomy version.

### E-05 — Academic Record
- **Purpose:** represent one committed period's worth of academic performance within a qualification.
- **Responsibilities:** hold the period's completion state (draft/committed) and anchor Subject Performance entries (E-06) for that period.
- **Business meaning:** answers "what did this student achieve in this specific period of this qualification" — e.g. "Class 10, Year 1 results."
- **Lifecycle — Creation:** created in draft state when a student begins entering results for a period.
- **Lifecycle — Updates:** freely editable while in draft state (supports partial/incremental save); becomes fully immutable the instant it is committed.
- **Lifecycle — Retirement:** never deleted; a committed record found to be wrong is corrected only via an explicit Amendment (Part 8), which creates a new record version linked to the one it supersedes — the original is retained, not removed.
- **Lifecycle — Archival:** retained permanently as the domain's core historical evidence.
- **Versioning:** each commit is version 1 of that period's record; an amendment produces version 2, and so on, each explicitly linked to its predecessor.
- **Audit strategy:** draft edits may be logged at a coarser grain (last-write-wins during drafting is acceptable, matching the confirmed current business need for partial saves); the commit event and every amendment event are always individually retained.

### E-06 — Subject Performance
- **Purpose:** the atomic unit of academic performance — one subject's result within one committed Academic Record.
- **Responsibilities:** hold marks/grade/percentage and the explicit source of how the percentage/grade was determined.
- **Business meaning:** answers "how did this student do in this specific subject, in this specific period."
- **Lifecycle — Creation:** created while the parent Academic Record is in draft state; must reference an existing Subject Selection (E-04) on the same qualification.
- **Lifecycle — Updates:** freely editable while the parent record is draft; immutable once the parent commits.
- **Lifecycle — Retirement:** never deleted; corrected only via the parent record's amendment mechanism.
- **Versioning:** inherits its version from the parent Academic Record's version.
- **Audit strategy:** inherits the parent record's audit events; individually notable only if a future capability allows subject-level (not whole-record) amendment, which this model does not currently define.

### E-07 — Cognitive Assessment Result
- **Purpose:** represent the scored outcome of one cognitive assessment attempt.
- **Responsibilities:** hold the five scored dimensions and the raw response payload for the attempt.
- **Business meaning:** answers "what did this specific assessment attempt reveal about this student's cognitive profile."
- **Lifecycle — Creation:** created once, at assessment completion.
- **Lifecycle — Updates:** none — immutable from creation.
- **Lifecycle — Retirement:** never deleted or superseded; a later, more recent attempt is simply a separate, later-dated E-07 instance. "Current" cognitive profile is a query (most recent by date), never a field that gets overwritten.
- **Versioning:** not applicable — each instance is already a permanent, dated snapshot.
- **Audit strategy:** the creation event is the complete audit record; no further events apply.

### E-08 — Activity Record
- **Purpose:** represent one extracurricular activity the student has reported.
- **Responsibilities:** hold the activity's name, level, and reporting date.
- **Business meaning:** answers "what has this student done outside formal academics."
- **Lifecycle — Creation:** created when reported.
- **Lifecycle — Updates:** none after creation; a correction is a new Activity Record explicitly marked as superseding the prior one (not a silent edit), preserving both.
- **Lifecycle — Retirement:** withdrawn activities are marked withdrawn, never deleted.
- **Versioning:** not applicable in the ordinary case; superseding correction follows the same amendment-link pattern as E-05.
- **Audit strategy:** creation and any supersession are discrete audit events.

### E-09 — Derived Academic Signal
- **Purpose:** represent one computed, versioned academic-intelligence output.
- **Responsibilities:** hold the computed value(s), the engine that produced them, and the exact Academic Context (E-10) version and Taxonomy Version (R-16) they were computed from.
- **Business meaning:** answers "what does the system currently infer about this student's academic affinity/trend," always traceable to what it was inferred from.
- **Lifecycle — Creation:** created on every computation run.
- **Lifecycle — Updates:** none — each run is a new, immutable instance.
- **Lifecycle — Retirement:** never deleted; superseded in relevance by later runs, retained for audit/explainability of past recommendations.
- **Versioning:** each instance carries its own engine version; there is no "the" current signal, only the most recent instance by computation date, exactly mirroring E-07's pattern.
- **Audit strategy:** creation is the audit record; consumers (Recommendation, Decision, Career Intelligence) are expected to reference the specific instance ID they used, not merely "the latest," so past decisions remain explainable even after a newer signal exists.

### E-10 — Academic Context
- **Purpose:** the single composed, versioned projection of the student's full academic picture, published for downstream consumption.
- **Responsibilities:** merge current state from E-01/E-02 with the latest relevant history from E-03 through E-08 into one coherent, queryable shape.
- **Business meaning:** answers, in one place, everything a downstream AI/runtime system needs to know about a student's academic standing, without that system needing to know which of the ten source entities anything came from.
- **Lifecycle — Creation:** created on first relevant event for a student.
- **Lifecycle — Updates:** fully rebuilt (not patched) whenever any source entity publishes a relevant event — "rebuilt" is a logical description, not a performance prescription; a real implementation may apply incremental recomputation, but the logical guarantee is that the result is always equivalent to a full rebuild.
- **Lifecycle — Retirement:** never explicitly retired; ceases to be produced only if the underlying student record is retired.
- **Versioning:** every rebuild produces a new context version number, referenced by every E-09 instance and every downstream projection (Part 12) that was computed from it.
- **Audit strategy:** each rebuild is logged with the set of source-entity events that triggered it, enabling replay (Part 8).

---

## PART 4 — Logical Attributes

Data types used below are logical only: **Text**, **Number**, **Boolean**, **Date**, **DateTime**, **Enumeration**, **Code Reference** (a business-key reference into a Part 7 reference entity, always paired with a Taxonomy Version), **Identifier** (an opaque logical identity, not a physical key type), **Percentage**, **Duration**, **Collection-of-X**.

### E-01 — Student Academic Profile

| Business Name | Business Meaning | Logical Type | Required | Default | Constraints | Validation | Mutability | Category |
|---|---|---|---|---|---|---|---|---|
| Profile Identifier | Uniquely identifies this profile | Identifier | Required | System-assigned | Unique per student | N/A | Immutable | System-generated |
| Student Identifier | The student this profile belongs to | Identifier | Required | N/A | Exactly one profile per student | Must reference an existing student | Immutable | System-generated |
| Country Reference | Student's current country of academic context | Code Reference (R-01) | Required | N/A | Must be an active Country entry | Must resolve against current Taxonomy Version | Mutable | Taxonomy Reference |
| Region Reference | Student's current region within Country | Code Reference (R-02) | Required | N/A | Must belong to the referenced Country | Must resolve against current Taxonomy Version | Mutable | Taxonomy Reference |
| Board Reference | Student's current examining board | Code Reference (R-03) | Required | N/A | Must be valid for the referenced Region (R-15) | Must resolve against current Taxonomy Version | Mutable | Taxonomy Reference |
| Current Academic Level Reference | Student's current stage (e.g. "Class 10") | Code Reference (R-06) | Required | N/A | Must belong to a Curriculum valid for the referenced Board | Must resolve against current Taxonomy Version | Mutable | Taxonomy Reference |
| Current Stream Reference | Student's current specialization, where applicable | Code Reference (R-08) | Optional | Null | Must belong to the current Academic Level, if set | Must resolve against current Taxonomy Version | Mutable | Taxonomy Reference |
| Current Institution Reference | Student's currently declared school/college | Code Reference (R-11) | Optional | Null | N/A | Must resolve against current Taxonomy Version, if set | Mutable | Taxonomy Reference |
| Profile Established Date | When the profile was first created | DateTime | Required | Creation timestamp | N/A | Not future-dated | Immutable | System-generated |
| Profile Last Updated Date | When the profile was last changed | DateTime | Required | Update timestamp | Must be ≥ Established Date | N/A | System-maintained | System-generated |
| Taxonomy Version At Last Update | Which Taxonomy Version the last update was resolved against | Code Reference (R-16) | Required | N/A | N/A | Must exist | System-maintained | Taxonomy Reference |

### E-02 — Language Preference

| Business Name | Business Meaning | Logical Type | Required | Default | Constraints | Validation | Mutability | Category |
|---|---|---|---|---|---|---|---|---|
| Language Preference Identifier | Uniquely identifies this entry | Identifier | Required | System-assigned | Unique within the owning profile's current set | N/A | Immutable | System-generated |
| Profile Reference | The profile this belongs to | Identifier (→ E-01) | Required | N/A | Must reference an existing profile | N/A | Immutable | System-generated |
| Language Reference | Which language | Code Reference (R-10) | Required | N/A | N/A | Must resolve against current Taxonomy Version | Immutable per entry (full-set replace to change) | Taxonomy Reference |
| Relationship Type | Medium of instruction vs. additional studied language | Enumeration (Medium, Additional) | Required | N/A | N/A | N/A | Immutable per entry | User-entered |
| Proficiency Level | Self-declared proficiency, applicable to additional languages | Enumeration (Basic, Intermediate, Fluent, Native) | Optional | Null | Required if Relationship Type = Additional | N/A | Immutable per entry | User-entered |
| Display Order | Order the student wishes this shown in | Number | Optional | 0 | N/A | Non-negative | Mutable | User-entered |
| Set Version | Which full-set replacement this entry belongs to | Number | Required | 1 | Increments on every full-set replacement | N/A | Immutable | System-generated |

### E-03 — Academic Qualification

| Business Name | Business Meaning | Logical Type | Required | Default | Constraints | Validation | Mutability | Category |
|---|---|---|---|---|---|---|---|---|
| Qualification Identifier | Uniquely identifies this qualification instance | Identifier | Required | System-assigned | N/A | N/A | Immutable | System-generated |
| Profile Reference | The profile this qualification belongs to | Identifier (→ E-01) | Required | N/A | Must reference an existing profile | N/A | Immutable | System-generated |
| Qualification Type Reference | What kind of credential this is | Code Reference (R-07) | Required | N/A | N/A | Must resolve against Taxonomy Version at creation | Immutable | Taxonomy Reference |
| Board Reference | Board this qualification is pursued under | Code Reference (R-03) | Required | N/A | May differ from the Profile's current Board Reference (explicit transfer scenario) | Must resolve against Taxonomy Version at creation | Immutable | Taxonomy Reference |
| Curriculum Reference | Curriculum this qualification follows | Code Reference (R-04) | Required | N/A | Must belong to the referenced Board | Must resolve against Taxonomy Version at creation | Immutable | Taxonomy Reference |
| Stream Reference | Specialization within the qualification, where applicable | Code Reference (R-08) | Optional | Null | Must belong to the referenced Curriculum, if set | Must resolve against Taxonomy Version at creation | Immutable | Taxonomy Reference |
| Institution Reference | Institution this qualification is pursued at | Code Reference (R-11) | Optional | Null | N/A | Must resolve against Taxonomy Version at creation, if set | Mutable (institution may be confirmed later) | Taxonomy Reference |
| Period Start | When this qualification's pursuit began | Date | Required | N/A | N/A | Not future-dated beyond a reasonable planning horizon | Immutable | User-entered |
| Period Target End | Expected completion date | Date | Optional | Null | Must be ≥ Period Start, if set | N/A | Mutable | User-entered |
| Period Actual End | Actual completion date | Date | Optional | Null | Must be ≥ Period Start, if set; set only once | Set only when Status transitions to Completed | Immutable once set | System-generated |
| Status | Current lifecycle state | Enumeration (Active, Completed, Discontinued) | Required | Active | Transitions: Active → Completed or Active → Discontinued only | N/A | Mutable (forward-only transitions) | System-generated |
| Taxonomy Version At Creation | Which Taxonomy Version this qualification's references were resolved against | Code Reference (R-16) | Required | N/A | N/A | Must exist | Immutable | Taxonomy Reference |

### E-04 — Subject Selection

| Business Name | Business Meaning | Logical Type | Required | Default | Constraints | Validation | Mutability | Category |
|---|---|---|---|---|---|---|---|---|
| Selection Identifier | Uniquely identifies this selection entry | Identifier | Required | System-assigned | N/A | N/A | Immutable | System-generated |
| Qualification Reference | The qualification this selection belongs to | Identifier (→ E-03) | Required | N/A | Must reference an existing, active qualification at creation | N/A | Immutable | System-generated |
| Subject Reference | Which subject | Code Reference (R-09) | Required | N/A | Must be valid for the qualification's Stream/Curriculum | Must resolve against Taxonomy Version at selection time | Immutable per entry | Taxonomy Reference |
| Selection Status | Whether currently enrolled or withdrawn | Enumeration (Enrolled, Withdrawn) | Required | Enrolled | Transitions: Enrolled → Withdrawn only | N/A | Mutable (forward-only) | System-generated |
| Is Primary | Whether this is a core/compulsory subject vs. elective | Boolean | Required | False | N/A | N/A | Immutable per entry | User-entered |
| Display Order | Order the student wishes this shown in | Number | Optional | 0 | N/A | Non-negative | Mutable | User-entered |
| Selected Date | When this selection was made | DateTime | Required | Creation timestamp | N/A | N/A | Immutable | System-generated |
| Withdrawn Date | When this selection was withdrawn, if applicable | DateTime | Optional | Null | Must be ≥ Selected Date, if set | Set only when Selection Status = Withdrawn | Immutable once set | System-generated |

### E-05 — Academic Record

| Business Name | Business Meaning | Logical Type | Required | Default | Constraints | Validation | Mutability | Category |
|---|---|---|---|---|---|---|---|---|
| Record Identifier | Uniquely identifies this record instance | Identifier | Required | System-assigned | N/A | N/A | Immutable | System-generated |
| Qualification Reference | The qualification this record belongs to | Identifier (→ E-03) | Required | N/A | Must reference an existing qualification | N/A | Immutable | System-generated |
| Period Reference | Which period within the qualification this covers (e.g. "Year 1") | Code Reference (R-06, scoped) | Required | N/A | Must be a valid Academic Level/period for the qualification's Curriculum | Must resolve against Taxonomy Version at creation | Immutable | Taxonomy Reference |
| Completion State | Draft or committed | Enumeration (Draft, Committed) | Required | Draft | Transitions: Draft → Committed only | Cannot commit with zero Subject Performance children | Mutable until committed, then immutable | System-generated |
| Committed Date | When this record was committed | DateTime | Optional | Null | Set only once, when Completion State becomes Committed | N/A | Immutable once set | System-generated |
| Record Version | Version number of this period's record | Number | Required | 1 | Increments only via Amendment | N/A | Immutable per instance | System-generated |
| Supersedes Record Reference | The prior version this amends, if any | Identifier (→ E-05) | Optional | Null | Must reference an existing, committed prior-version record for the same Qualification + Period | N/A | Immutable | System-generated |
| Is Predicted | Whether this period's results are predicted/provisional rather than final | Boolean | Required | False | N/A | N/A | Immutable once committed | User-entered |

### E-06 — Subject Performance

| Business Name | Business Meaning | Logical Type | Required | Default | Constraints | Validation | Mutability | Category |
|---|---|---|---|---|---|---|---|---|
| Performance Identifier | Uniquely identifies this performance entry | Identifier | Required | System-assigned | N/A | N/A | Immutable | System-generated |
| Record Reference | The Academic Record this belongs to | Identifier (→ E-05) | Required | N/A | Must reference an existing record | N/A | Immutable | System-generated |
| Subject Selection Reference | The Subject Selection this performance fulfills | Identifier (→ E-04) | Required | N/A | Must reference a Subject Selection on the same Qualification | N/A | Immutable | System-generated |
| Marks Obtained | Raw marks scored | Number | Optional | Null | Must be ≥ 0 if set; must not exceed Maximum Marks | Numeric range check | Immutable once record committed | User-entered |
| Maximum Marks | Marks the subject was assessed out of | Number | Optional | Null | Must be > 0 if set | N/A | Immutable once record committed | User-entered |
| Grade | Normalized letter/scale grade | Code Reference (R-14, grade-scale entry) | Optional | Null | Must be a valid entry in the Grade System referenced by the qualification's Curriculum | N/A | Immutable once record committed | User-entered or Derived (see Percentage Source) |
| Percentage | Computed or provided percentage | Percentage | Optional | Null | 0–100 inclusive if set | Derived from Marks Obtained/Maximum Marks when both present | Immutable once record committed | Derived |
| Percentage Source | How the Percentage/Grade values were determined | Enumeration (Marks-Derived, Grade-Inferred, None) | Required | None | N/A | N/A | Immutable once record committed | System-generated |
| Source Type | How this performance data was originally captured | Enumeration (Manual, Optical-Character-Recognition, Imported) | Required | Manual | N/A | N/A | Immutable | User-entered/System-generated |
| Is Predicted | Whether this specific subject's marks are predicted/provisional | Boolean | Required | False | N/A | N/A | Immutable once record committed | User-entered |

### E-07 — Cognitive Assessment Result

| Business Name | Business Meaning | Logical Type | Required | Default | Constraints | Validation | Mutability | Category |
|---|---|---|---|---|---|---|---|---|
| Assessment Result Identifier | Uniquely identifies this attempt's result | Identifier | Required | System-assigned | N/A | N/A | Immutable | System-generated |
| Profile Reference | The profile this assessment belongs to | Identifier (→ E-01) | Required | N/A | Must reference an existing profile | N/A | Immutable | System-generated |
| Assessment Date | When the assessment was completed | DateTime | Required | Completion timestamp | Not future-dated | N/A | Immutable | System-generated |
| Analytical Score | Scored dimension: analytical reasoning | Number | Required | N/A | Within the defined scale for the assessment version | N/A | Immutable | Derived |
| Logical Score | Scored dimension: logical reasoning | Number | Required | N/A | Within the defined scale for the assessment version | N/A | Immutable | Derived |
| Memory Score | Scored dimension: memory | Number | Required | N/A | Within the defined scale for the assessment version | N/A | Immutable | Derived |
| Communication Score | Scored dimension: communication | Number | Required | N/A | Within the defined scale for the assessment version | N/A | Immutable | Derived |
| Creativity Score | Scored dimension: creativity | Number | Required | N/A | Within the defined scale for the assessment version | N/A | Immutable | Derived |
| Raw Responses | The student's raw answers to the assessment, as an immutable structured record | Collection-of-Text | Required | N/A | N/A | N/A | Immutable | User-entered |
| Assessment Version | Which version of the assessment instrument was used | Text | Required | N/A | N/A | N/A | Immutable | System-generated |

### E-08 — Activity Record

| Business Name | Business Meaning | Logical Type | Required | Default | Constraints | Validation | Mutability | Category |
|---|---|---|---|---|---|---|---|---|
| Activity Record Identifier | Uniquely identifies this entry | Identifier | Required | System-assigned | N/A | N/A | Immutable | System-generated |
| Profile Reference | The profile this activity belongs to | Identifier (→ E-01) | Required | N/A | Must reference an existing profile | N/A | Immutable | System-generated |
| Activity Name | Name/description of the activity | Text | Required | N/A | N/A | Non-empty | Immutable | User-entered |
| Activity Level | Level attained (e.g. school, national, international) | Enumeration (Beginner, Intermediate, Advanced, National, International) | Required | N/A | N/A | N/A | Immutable | User-entered |
| Reported Date | When this activity was reported | DateTime | Required | Creation timestamp | N/A | N/A | Immutable | System-generated |
| Status | Whether currently active or withdrawn | Enumeration (Active, Withdrawn) | Required | Active | Transitions: Active → Withdrawn only | N/A | Mutable (forward-only) | System-generated |
| Supersedes Activity Reference | A prior Activity Record this corrects, if any | Identifier (→ E-08) | Optional | Null | Must reference an existing Activity Record for the same profile | N/A | Immutable | System-generated |

### E-09 — Derived Academic Signal

| Business Name | Business Meaning | Logical Type | Required | Default | Constraints | Validation | Mutability | Category |
|---|---|---|---|---|---|---|---|---|
| Signal Identifier | Uniquely identifies this computation run's output | Identifier | Required | System-assigned | N/A | N/A | Immutable | System-generated |
| Profile Reference | The profile this signal applies to | Identifier (→ E-01) | Required | N/A | Must reference an existing profile | N/A | Immutable | System-generated |
| Signal Type | What kind of derived signal this is (e.g. Stream Affinity, Academic Trend) | Enumeration | Required | N/A | N/A | N/A | Immutable | System-generated |
| Signal Values | The computed value(s) for this signal type | Collection-of-Number | Required | N/A | N/A | N/A | Immutable | Derived |
| Confidence | The engine's stated confidence in this signal | Percentage | Optional | Null | 0–100 if set | N/A | Immutable | Derived |
| Engine Version | Which computation engine/model version produced this | Text | Required | N/A | N/A | N/A | Immutable | System-generated |
| Source Academic Context Version | The exact Academic Context (E-10) version this was computed from | Identifier (→ E-10 version) | Required | N/A | Must reference an existing Academic Context version | N/A | Immutable | System-generated |
| Source Taxonomy Version | The Taxonomy Version active at computation time | Code Reference (R-16) | Required | N/A | Must exist | N/A | Immutable | Taxonomy Reference |
| Computed Date | When this run occurred | DateTime | Required | Computation timestamp | N/A | N/A | Immutable | System-generated |

### E-10 — Academic Context (Projection)

| Business Name | Business Meaning | Logical Type | Required | Default | Constraints | Validation | Mutability | Category |
|---|---|---|---|---|---|---|---|---|
| Context Identifier | Uniquely identifies this projection instance | Identifier | Required | System-assigned | N/A | N/A | Immutable per version | System-generated |
| Profile Reference | The profile this context represents | Identifier (→ E-01) | Required | N/A | Must reference an existing profile | N/A | Immutable | System-generated |
| Context Version | Monotonically increasing version of this student's projection | Number | Required | 1 | Increments on every rebuild | N/A | Immutable per instance | System-generated |
| Identity Snapshot | Composed current identity (from E-01/E-02) | Collection (embedded) | Required | N/A | N/A | N/A | Immutable per version | Derived/Projection |
| Active Qualification Snapshot | Composed current qualification(s), selections (from E-03/E-04) | Collection (embedded) | Required | N/A | N/A | N/A | Immutable per version | Derived/Projection |
| Performance History Summary | Composed summary of committed records (from E-05/E-06) | Collection (embedded) | Required | N/A | N/A | N/A | Immutable per version | Derived/Projection |
| Cognitive & Activity Summary | Composed summary (from E-07/E-08) | Collection (embedded) | Optional | Empty | N/A | N/A | Immutable per version | Derived/Projection |
| Source Event References | The specific source-entity events that triggered this rebuild | Collection-of-Identifier | Required | N/A | N/A | N/A | Immutable per version | System-generated |
| Generated Date | When this version was produced | DateTime | Required | Generation timestamp | N/A | N/A | Immutable per version | System-generated |

---

## PART 5 — Relationships

| Parent | Child | Relationship Type | Cardinality | Ownership | Cascade Behaviour | Lifecycle Dependency | Business Justification |
|---|---|---|---|---|---|---|---|
| E-01 Student Academic Profile | E-02 Language Preference | Composition | 1 → 0..N | Parent owns child | Child set replaced wholesale with parent updates; not independently deletable outside a full-set replace | Child cannot outlive parent | Language preferences have no independent meaning outside the profile that holds them (WP-ARCH-01A.2 §2.8) |
| E-01 Student Academic Profile | E-03 Academic Qualification | Aggregate reference (not composition) | 1 → 0..N | Parent context anchors, but child is independently addressable | Qualifications are never cascade-deleted with the profile; they persist as historical fact | Child can be read/referenced independently of the current profile state | A student's qualification history must remain queryable even as their current profile identity changes (WP-ARCH-01B Part 3.2) |
| E-03 Academic Qualification | E-04 Subject Selection | Composition | 1 → 0..N | Parent owns child | Selections are withdrawn (not deleted) if the qualification is discontinued | Child's active lifecycle bounded by parent's Active status | Subjects only make sense in the context of the specific qualification they were selected for |
| E-03 Academic Qualification | E-05 Academic Record | Aggregate reference | 1 → 0..N | Parent anchors, child independently addressable | Records are never cascade-deleted with the qualification | Records can be read independently once committed, even after the qualification completes | Historical performance must remain fully queryable after a qualification is completed, not just while it is active |
| E-05 Academic Record | E-06 Subject Performance | Composition | 1 → 1..N | Parent owns child | Child committed/amended only as part of the whole parent record | Child cannot exist without a parent record; cannot outlive an amendment (both old and new record versions retain their own children) | A period's subject results are one coherent unit — resolves the "replace-all as one unit" property this design deliberately preserved (WP-ARCH-01B Part 3.3) |
| E-04 Subject Selection | E-06 Subject Performance | Reference (fulfillment) | 1 → 0..N | Neither owns the other; explicit business reference | No cascade; a withdrawn selection does not retract already-committed performance | Performance can reference a since-withdrawn selection (history is preserved) | A performance entry must always be traceable to what was selected, even if the selection later changes (WP-ARCH-01B Part 3.4) |
| E-05 Academic Record | E-05 Academic Record (self-reference, via Supersedes) | Association (versioning) | 0..1 → 0..1 | N/A — peer versions | No cascade; both versions retained permanently | New version's existence depends on old version already existing | Explicit amendment/supersession is the domain's sole correction mechanism (WP-ARCH-01B Part 7) |
| E-01 Student Academic Profile | E-07 Cognitive Assessment Result | Aggregate reference | 1 → 0..N | Parent context anchors, child independently addressable | No cascade; results persist independent of profile changes | None — fully independent once created | Assessment history must remain intact regardless of later profile changes |
| E-01 Student Academic Profile | E-08 Activity Record | Aggregate reference | 1 → 0..N | Parent context anchors, child independently addressable | No cascade; records persist independent of profile changes | None — fully independent once created | Activity history must remain intact regardless of later profile changes |
| E-08 Activity Record | E-08 Activity Record (self-reference, via Supersedes) | Association (versioning) | 0..1 → 0..1 | N/A — peer versions | No cascade; both retained | New instance depends on prior existing | Same amendment pattern as E-05, applied consistently |
| E-10 Academic Context | E-01…E-08 (all) | Derivation (event-sourced projection) | N → 1 (per version) | Composition Context owns the projection; source entities own their own truth | Projection rebuilt, never cascades back to sources | Projection version depends on the state of all source entities at rebuild time | The projection is explicitly non-authoritative (WP-ARCH-01B Part 3.6) — it depends on everything but owns nothing |
| E-09 Derived Academic Signal | E-10 Academic Context (specific version) | Reference | N → 1 | Derived Intelligence Context owns E-09; Composition Context owns E-10 | No cascade | E-09 instance is meaningless without a valid E-10 version reference | Explainability requires every derived signal to name exactly what it was computed from (WP-ARCH-01B ADR-08) |
| R-16 Taxonomy Version | E-01, E-03, E-04, E-05, E-06, E-07, E-08, E-09, E-10 | Reference | 1 → N | Taxonomy Context owns R-16; every consuming entity references it | No cascade; taxonomy publication never rewrites existing entity references | Every referencing entity's Code References are resolved against the specific version they cite | Auditability and correct historical reinterpretation depend on knowing which taxonomy state was in effect at the time (WP-ARCH-01B Part 6) |
| R-03 Board | R-02 Region (via R-15 Board-Region Map) | Association (many-to-many) | N ↔ N | Taxonomy Context | N/A — reference data only | N/A | A board may operate in multiple regions and a region may host multiple boards (WP-ARCH-01A.2 §2.6 evidence) |
| R-04 Curriculum | R-03 Board | Reference | N → 1 | Taxonomy Context | N/A | N/A | A curriculum is defined under exactly one board |
| R-06 Academic Level | R-04 Curriculum | Reference | N → 1 | Taxonomy Context | N/A | N/A | Levels are curriculum-specific (a "Class 10" concept only makes sense within a specific curriculum's structure) |
| R-08 Stream | R-06 Academic Level | Reference | N → 1 | Taxonomy Context | N/A | N/A | Streams apply within a specific level of a specific curriculum |
| R-09 Subject | R-08 Stream | Reference (many-to-many) | N ↔ N | Taxonomy Context | N/A | N/A | A subject may belong to multiple streams (e.g. Mathematics appears in several streams) |

---

## PART 6 — Business Constraints

### 6.1 Uniqueness constraints
- Exactly one E-01 Student Academic Profile per student, at all times (WP-ARCH-01B Part 3.1 invariant).
- Exactly one active (non-withdrawn) E-04 Subject Selection per (Qualification, Subject) pair at any point in time — a subject may be re-selected after withdrawal, producing a new selection entry, but never two simultaneously-active selections for the same subject on the same qualification.
- At most one E-05 Academic Record per (Qualification, Period) with Completion State = Committed **at the current highest Record Version** — prior versions remain retrievable but are not "the" record for that period.
- At most one E-06 Subject Performance per (Academic Record, Subject Selection) pair.

### 6.2 Mandatory relationships
- An E-03 Academic Qualification must reference an existing E-01 Profile.
- An E-04 Subject Selection must reference an existing, at-the-time-active E-03 Qualification.
- An E-05 Academic Record must reference an existing E-03 Qualification.
- An E-06 Subject Performance must reference both an existing E-05 Record (as parent) and an existing E-04 Selection (as fulfillment target) on the *same* Qualification — cross-qualification references are prohibited.
- Every Code Reference attribute (Part 4) must resolve against the Taxonomy Version cited on the same entity instance.

### 6.3 Business invariants (carried forward from WP-ARCH-01A.2 §9 and WP-ARCH-01B Part 3, restated at the logical-model level)
- Marks Obtained (E-06) must not exceed Maximum Marks (E-06) — a same-entity cross-attribute constraint.
- An E-05 Record cannot transition to Committed while it has zero E-06 children.
- E-03 Qualification Status transitions are forward-only: Active → Completed, or Active → Discontinued; no transition returns to Active.
- E-04 Selection Status transitions are forward-only: Enrolled → Withdrawn only.
- E-05 Record Completion State transitions are forward-only: Draft → Committed only; a committed record is never returned to Draft (correction is via Amendment, a new instance, not a state reversal).

### 6.4 Validation rules
- All Date/DateTime attributes recording an event must not be future-dated beyond the specific tolerances noted per-attribute in Part 4 (e.g. qualification planning horizons).
- Every Percentage attribute (E-06, E-09) must fall within 0–100 inclusive.
- Every Code Reference must be an entry marked active (not deprecated) in the Taxonomy Version being resolved against, **except** when resolving a historical entity's already-recorded reference for read purposes — deprecated entries remain resolvable for historical reads, only unavailable for new writes (this is the concrete mechanism behind the "never remove enum values" governance rule carried into Part 14).

### 6.5 Lifecycle rules
- No entity in the Historical or Derived layers (Part 1.1) may be physically deleted by any ordinary business operation; retirement is always a status transition or a supersession link, never a removal.
- Only entities in the Operational layer (E-01, E-02) support true in-place mutation; every other entity's "update" is logically a new instance plus a linkage, even where an implementation might choose to represent it more efficiently.

### 6.6 Historical constraints
- An E-05 Amendment (new Record Version) must reference the exact prior version it supersedes via Supersedes Record Reference — chains of supersession must be traceable back to Version 1 with no gaps.
- An E-08 Activity Record correction must likewise reference the specific prior instance it supersedes.
- E-07 Cognitive Assessment Results and E-09 Derived Academic Signals do not support amendment at all — an incorrect attempt or computation is not corrected in place; a new, later-dated instance simply supersedes the old one in relevance (not in existence).

### 6.7 Reference integrity rules
- Every reference from an operational/historical/derived entity into a reference entity (Part 7) must specify the Taxonomy Version the reference was resolved against; a reference with no accompanying version is invalid at the logical-model level.
- A reference entity (R-01 through R-15) may be deprecated but never physically removed from a published Taxonomy Version once any operational/historical/derived entity has referenced it.

### 6.8 Versioning constraints
- Context Version (E-10) must strictly increase for a given profile on every rebuild; no two E-10 instances for the same profile may share a version number.
- Record Version (E-05) must strictly increase within a given (Qualification, Period) supersession chain.
- Taxonomy Version (R-16) must strictly increase globally across the whole reference-data set; it is never scoped per-country or per-board.

---

## PART 7 — Reference Data Model

| Ref | Entity | Purpose | Ownership | Versioning | Lifecycle | Publication | Consumption |
|---|---|---|---|---|---|---|---|
| R-01 | Country | Defines the top-level jurisdiction an academic identity or qualification is anchored to | Academic Taxonomy Context, governed by a taxonomy stewardship process (Part 14) | Included in every Taxonomy Version snapshot; individual entries carry their own effective-from date | Published → Active → Deprecated (never deleted) | Published as part of a Taxonomy Version release | Referenced by E-01, E-03 (directly or transitively via Region) |
| R-02 | Region | Defines a sub-national area (state/province) within a Country | Academic Taxonomy Context | Same as R-01 | Same as R-01 | Same as R-01 | Referenced by E-01, E-03; associates to R-03 via R-15 |
| R-03 | Board | Defines an examining/education body | Academic Taxonomy Context | Same as R-01 | Same as R-01 | Same as R-01 | Referenced by E-01, E-03 |
| R-04 | Curriculum | Defines a specific course of study under a Board | Academic Taxonomy Context | Same as R-01 | Same as R-01 | Same as R-01 | Referenced by E-03 |
| R-05 | Program | Defines a named higher-education program of study | Academic Taxonomy Context | Same as R-01 | Same as R-01 | Same as R-01 | Referenced by E-03 (future undergraduate/postgraduate qualifications, per WP-ARCH-01B ADR-02) |
| R-06 | Academic Level | Defines a stage within a Curriculum (e.g. "Class 10") | Academic Taxonomy Context | Same as R-01 | Same as R-01 | Same as R-01 | Referenced by E-01, E-05 (as Period Reference) |
| R-07 | Qualification Type | Defines the category of credential (e.g. Secondary School Certificate, Undergraduate Degree) | Academic Taxonomy Context | Same as R-01 | Same as R-01 | Same as R-01 | Referenced by E-03 |
| R-08 | Stream | Defines a specialization within an Academic Level (e.g. Science, Commerce) | Academic Taxonomy Context | Same as R-01 | Same as R-01 | Same as R-01 | Referenced by E-01, E-03; associates to R-09 |
| R-09 | Subject | Defines an academic subject | Academic Taxonomy Context | Same as R-01 | Same as R-01 | Same as R-01 | Referenced by E-04 |
| R-10 | Language | Defines a language | Academic Taxonomy Context | Same as R-01 | Same as R-01 | Same as R-01 | Referenced by E-02 |
| R-11 | Institution | Defines a specific school/college/university | Academic Taxonomy Context | Same as R-01 | Same as R-01 | Same as R-01 | Referenced by E-01, E-03 (optional) |
| R-12 | Assessment System | Defines an evaluation methodology a Curriculum uses | Academic Taxonomy Context | Same as R-01 | Same as R-01 | Same as R-01 | Referenced transitively via R-04 |
| R-13 | Credit System | Defines an academic-credit scheme a Curriculum/Program uses | Academic Taxonomy Context | Same as R-01 | Same as R-01 | Same as R-01 | Referenced transitively via R-04/R-05 |
| R-14 | Grade System | Defines a grading scale a Curriculum uses | Academic Taxonomy Context | Same as R-01 | Same as R-01 | Same as R-01 | Referenced by E-06 (Grade attribute) |
| R-15 | Board-Region Map | Defines which Boards operate in which Regions | Academic Taxonomy Context | Same as R-01 | Same as R-01 | Same as R-01 | Consumed by validation logic for E-01/E-03's Board Reference against Region Reference |
| R-16 | Taxonomy Version | An immutable stamp of the full reference-data state at a point in time | Academic Taxonomy Context | Is itself the unit of versioning — has no "version of a version" | Published, permanent | Published on any change to any R-01…R-15 entry | Referenced by every entity in Part 4 that carries a Code Reference |

**Common publication/consumption model across all reference entities:** every change to any reference entity produces a new R-16 Taxonomy Version; consumers (all other bounded contexts) receive `TaxonomyVersionPublished` (Part 11) and may choose when to adopt the new version for new writes, while all historical reads continue resolving against whichever version they originally cited.

---

## PART 8 — Versioning Model

| Entity | Current Version | Historical Versions | Snapshots | Amendments | Supersession | Replay | Event References | Business Version | Taxonomy Version | AI Context Version |
|---|---|---|---|---|---|---|---|---|---|---|
| E-01 Profile | Latest state, no version number needed (current-state entity) | Not retained on the entity itself; reconstructable from audit log | N/A | N/A | N/A | Reconstructable from audit events if needed | Audit log only | N/A | Cites version active at last update | N/A |
| E-02 Language Preference | Current set only | Prior sets retrievable via Set Version + audit log | N/A | N/A (full-set replace, not amendment) | N/A | Reconstructable from audit events | Audit log only | Set Version | Cites version active at entry creation | N/A |
| E-03 Qualification | The single instance (identity facts immutable) | N/A — status transitions are the only "history," retained in place | N/A | Not supported (see Part 6.6) | N/A | Directly readable, no replay needed | Creation + transition events | N/A | Cites version active at creation | N/A |
| E-04 Selection | Current active set per qualification | Full add/withdraw history retained as separate instances | N/A | N/A (add/withdraw, not amendment) | N/A | Directly readable | Creation + withdrawal events | N/A | Cites version active at selection | N/A |
| E-05 Academic Record | Highest Record Version with Completion State = Committed | Every prior version fully retained | Each committed version **is** the snapshot for its period | Supported — new version + Supersedes Record Reference | Explicit, one-hop link per version | Directly readable; replay used only to reconstruct E-10 | Commit + amendment events | Record Version | Cites version active at creation | N/A |
| E-06 Subject Performance | Inherits parent E-05's version | Inherits parent's history | Inherits parent's snapshot | Inherits parent's amendment (whole-record) | Inherits parent's supersession | Inherits parent | Inherits parent's events | Inherits parent's Record Version | Cites version active at creation | N/A |
| E-07 Cognitive Result | Each instance is independently "current" by recency | All instances retained permanently | Each instance is its own snapshot | Not supported | Not applicable (superseded in relevance only, by a later, unlinked instance) | Directly readable | Creation event | N/A | Cites version active at creation | N/A |
| E-08 Activity Record | Each active instance | All instances (including withdrawn/superseded) retained | Each instance is its own snapshot | Supported — new instance + Supersedes Activity Reference | Explicit, one-hop link | Directly readable | Creation + withdrawal/supersession events | N/A | Cites version active at creation | N/A |
| E-09 Derived Signal | Each computation run is independently "current" by recency | All runs retained permanently | Each run is its own snapshot | Not supported | Not applicable | Directly readable | Computation event | Engine Version | Cites version active at computation | Cites the E-10 version it was computed from |
| E-10 Academic Context | Highest Context Version per profile | Every prior version retained (or reconstructable by replay) | Each version is itself a full snapshot | N/A — rebuilt, not amended | N/A — a rebuild does not "supersede," it simply produces the next version | This is the primary replay target: reconstructable by replaying source-entity events in order | Source Event References attribute lists exactly what triggered each version | Context Version | Reflects the highest Taxonomy Version among all sources composed | Is itself the AI Context Version basis for E-09 and Part 12 projections |
| R-01…R-15 Reference entities | Latest entry per code, as of the latest R-16 | Every deprecated/superseded entry retained, tagged with its originating R-16 | The full reference set at any past R-16 is itself a complete snapshot | Not applicable — reference changes are always additive/deprecating, never in-place edits | Deprecation is the reference-data equivalent of supersession | Directly readable at any historical R-16 | N/A (reference publication is the event) | N/A | Is the Taxonomy Version | N/A |
| R-16 Taxonomy Version | The latest published version | Every prior version retained permanently | Each R-16 instance is a snapshot boundary for the whole reference set | Not applicable | Strictly sequential — each version supersedes the last globally | N/A — this entity is the replay anchor for everything else | `TaxonomyVersionPublished` event | Is itself the version | N/A | N/A |

---

## PART 9 — Audit Model

### 9.1 Standard audit attributes (applied to every entity in the write model — E-01 through E-09)

| Audit Attribute | Business Meaning | Logical Type | Required |
|---|---|---|---|
| Created By | The actor (student, system process, or administrative user) who created this instance | Identifier | Required |
| Created At | When this instance was created | DateTime | Required |
| Updated By | The actor who most recently changed this instance (current-state entities only) | Identifier | Optional (only where mutation in place is permitted, per Part 1.1) |
| Updated At | When this instance was most recently changed | DateTime | Optional (as above) |
| Change Reason | A business-meaningful reason for the change, required for any correction/amendment | Text | Required for Amendment/Supersession events; optional otherwise |
| Business Event | The named domain event this change corresponds to (Part 11) | Text | Required |
| Version | The version identifier applicable to this entity (per Part 8's per-entity scheme) | Number or Identifier | Required |
| Audit Classification | Categorizes the change for retention/sensitivity purposes | Enumeration (Routine, Correction, System-Generated, Administrative) | Required |

### 9.2 Soft delete policy
No entity in the Historical or Derived layers supports deletion, soft or hard, through ordinary business operation — this is a direct consequence of the append-only design (Part 1.1, Part 6.5). Operational-layer entities (E-01, E-02) support a **status-based soft retirement** only at the level of the whole student record (outside this domain's direct scope), never at the level of an individual profile or preference field.

### 9.3 Retention policy
- **Reference data (R-01–R-16):** retained permanently; deprecated entries are retained for as long as any historical entity references them, which — given the append-only design — is effectively permanent.
- **Operational, Historical, and Derived data (E-01–E-09):** retained per the platform-wide student-data retention policy (outside this domain's scope to define), but this domain's logical model imposes no additional deletion trigger of its own — the domain's default is indefinite retention, with removal governed entirely by an external, account-level policy.
- **Projections (E-10) and downstream projections (Part 12):** retained only as long as operationally useful for replay/debugging; because they are fully rebuildable from retained source events, their own retention can be shorter than the source data's without any information loss.

---

## PART 10 — Permission Model

Conceptual only — no RLS, no physical roles.

| Entity | Owner (business) | Read | Write (Create) | Update | Delete Policy | System Access | Runtime Access | AI Access | Recommendation Access | Decision Engine Access | Administrative Access |
|---|---|---|---|---|---|---|---|---|---|---|---|
| E-01 Profile | The student | Student (own record only); Composition Context; Administrative support role | Identity Context command surface only | Identity Context command surface only | No delete; retirement only via account-level process | Identity Context service identity | Composition Context (read-only) | No direct access — via E-10 only | No direct access — via E-10 only | No direct access — via E-10 only | Read + correction, with mandatory Change Reason |
| E-02 Language Preference | The student | Same as E-01 | Identity Context command surface only | Full-set replace only, via Identity Context | No delete; withdrawal via full-set replace | Identity Context service identity | Composition Context (read-only) | No direct access | No direct access | No direct access | Read + correction |
| E-03 Qualification | The student | Student (own record); Composition Context; Performance Context (read, to validate record anchoring); Career Outcome Intelligence Engine (read, per WP-ARCH-01B Part 5 step 13's justified exception) | Identity Context command surface only | Status-transition only, via Identity Context | No delete; discontinuation only | Identity Context service identity | Composition Context, Career Outcome Intelligence Engine (both read-only) | No direct access | No direct access | No direct access | Read + status correction |
| E-04 Selection | The student | Student (own record); Composition Context; Performance Context (read, for E-06 validation) | Identity Context command surface only | Add/withdraw only, via Identity Context | No delete; withdrawal only | Identity Context service identity | Composition Context (read-only) | No direct access | No direct access | No direct access | Read only |
| E-05 Academic Record | The student | Student (own record, while draft); Composition Context; Derived Intelligence Context; Career Outcome Intelligence Engine (justified exception, immutable history only) | Performance Context command surface only | Draft-state edit only, via Performance Context; committed records never updated | No delete; amendment only, with Change Reason required | Performance Context service identity | Composition Context, Career Outcome Intelligence Engine, Derived Intelligence Context (all read-only) | No direct access — via E-10 or Derived Intelligence only | No direct access | No direct access | Read only; amendment requires the same command surface as ordinary use, with elevated audit classification |
| E-06 Subject Performance | The student | Same as E-05 | Performance Context command surface only | Draft-state edit only; immutable once parent committed | No delete; inherits parent record's amendment mechanism | Performance Context service identity | Same as E-05 | No direct access | No direct access | No direct access | Read only |
| E-07 Cognitive Result | The student | Student (own record); Composition Context; Derived Intelligence Context | Cognitive & Activity Context command surface only | Not updatable | No delete | Cognitive & Activity Context service identity | Composition Context, Derived Intelligence Context (read-only) | No direct access | No direct access | No direct access | Read only |
| E-08 Activity Record | The student | Student (own record); Composition Context | Cognitive & Activity Context command surface only | Not updatable in place; supersession only | No delete; withdrawal/supersession only | Cognitive & Activity Context service identity | Composition Context (read-only) | No direct access | No direct access | No direct access | Read only |
| E-09 Derived Signal | System (no individual business owner) | Recommendation Engine, Decision Engine, Career Intelligence, AI Context Generation (all read-only) | Derived Intelligence Context computation process only | Not updatable | No delete; superseded in relevance only | Derived Intelligence Context service identity | N/A | Read-only (via published signal, always with version reference) | Read-only | Read-only | Read only |
| E-10 Academic Context | System (Composition Context is the sole producer) | Student Context Runtime, Knowledge Runtime, and by extension every downstream consumer named in Part 12 (all read-only) | Composition Context rebuild process only | N/A — rebuilt, not updated | No delete; historical versions retained for replay | Composition Context service identity | All ten named downstream runtimes/engines (read-only, no exceptions) | Read-only, always version-stamped | Read-only, indirectly via Knowledge Runtime | Read-only, indirectly | Read only |
| R-01…R-16 Reference data | Taxonomy governance process (Part 14) | Every bounded context and every downstream consumer (universal read) | Taxonomy governance process only | Deprecation only; no in-place edit of a published entry | No delete; deprecation only | All contexts | All runtimes (read-only) | Read-only | Read-only | Read-only | Full publish/deprecate rights, restricted to the taxonomy stewardship role |

**Cross-cutting rule (applies to every row above):** no runtime, AI system, recommendation engine, or decision engine listed in the "Runtime/AI/Recommendation/Decision" columns ever has Write, Update, or Delete access to any entity in this domain — this is the permission-model expression of WP-ARCH-01B ADR-06, made explicit per entity rather than stated once as a general rule.

---

## PART 11 — Enterprise Event Model

| Aggregate | Events | Publisher | Consumers | Business Trigger | Ordering | Idempotency | Replay Behaviour | Version Compatibility |
|---|---|---|---|---|---|---|---|---|
| E-01 Profile | `AcademicProfileEstablished`, `AcademicProfileUpdated` | Identity Context | Composition Context | Student completes initial identity setup / changes identity fields | Per-profile ordering required (a profile's own event stream must be strictly ordered) | Establishing an already-established profile is a no-op, not an error, keyed on Student Identifier | Replaying a profile's event stream must reconstruct the exact current state | New optional fields may be added to future event versions without breaking older consumers; required-field changes require a new event name, not a silent shape change |
| E-02 Language Preference | `LanguagePreferenceSetReplaced` | Identity Context | Composition Context | Student changes their language selections | Ordered within the owning profile's stream | Replacing with an identical set is a no-op | Replaying reconstructs the current set from the latest replacement event only (prior sets are historical, not re-applied) | Same as E-01 |
| E-03 Qualification | `QualificationStarted`, `QualificationCompleted`, `QualificationDiscontinued` | Identity Context | Composition Context, Performance Context, Career Outcome Intelligence Engine | Student begins/finishes/abandons a stage of education | Ordered within the owning qualification's stream; `Started` must precede any other event for the same qualification | Each event is uniquely keyed to one qualification instance; re-delivery is a no-op | Directly replayable; no dependency on other qualifications' streams | Status-transition events are additive; new terminal statuses require a new event name |
| E-04 Selection | `SubjectSelected`, `SubjectWithdrawn` | Identity Context | Composition Context, Performance Context | Student adds/removes a subject from an active qualification | Ordered within the owning qualification's stream | Selecting an already-selected, active subject is a no-op | Directly replayable | Additive only |
| E-05 Academic Record | `AcademicRecordDrafted`, `AcademicRecordCommitted`, `AcademicRecordAmended` | Performance Context | Composition Context, Derived Intelligence Context, Career Outcome Intelligence Engine | Student begins/finalizes/corrects a period's results | Strictly ordered within the (Qualification, Period) supersession chain; `Committed` must precede any `Amended` for the same chain | `Committed`/`Amended` are one-time, uniquely-versioned events — never re-delivered as a no-op, since each carries a distinct Record Version | Replay must apply amendments in Record Version order to reach current state, while retaining every prior version as independently readable | An amendment event's shape must remain a superset-compatible extension of the commit event's shape |
| E-06 Subject Performance | Embedded in parent E-05 events (no independent event stream) | Performance Context | Same as E-05 | Same as E-05 | Same as E-05 | Same as E-05 | Same as E-05 | Same as E-05 |
| E-07 Cognitive Result | `CognitiveAssessmentCompleted` | Cognitive & Activity Context | Composition Context, Derived Intelligence Context | Student completes an assessment attempt | Each event independent — no cross-event ordering requirement (each attempt stands alone) | Uniquely keyed per attempt; re-delivery is a no-op | Directly replayable, order-independent | Additive only |
| E-08 Activity Record | `ActivityRecorded`, `ActivityWithdrawn`, `ActivityCorrected` | Cognitive & Activity Context | Composition Context | Student reports/removes/corrects an activity | Ordered only within a supersession chain (`Corrected` references its predecessor) | Uniquely keyed per instance | Directly replayable | Additive only |
| E-09 Derived Signal | `DerivedSignalComputed` | Derived Intelligence Context | Recommendation Engine, Decision Engine, Career Intelligence, AI Context Generation | A computation run completes (triggered by `AcademicContextRefreshed` or a scheduled/on-demand recompute) | Each run independent; no ordering requirement across runs, only a Computed Date for recency queries | Uniquely keyed per run | Directly replayable, order-independent | New signal types are additive; changing what an existing Signal Type means requires a new type, not a redefinition |
| E-10 Academic Context | `AcademicContextRefreshed` | Composition Context | Student Context Runtime and, transitively, every downstream consumer in Part 12 | Any relevant event from E-01–E-08 | Strictly ordered per profile (Context Version must increase monotonically) | Re-processing the same source event twice must not produce two context versions — the projection rebuild is itself idempotent, keyed on the triggering event's own identifier | This is the domain's primary replay target: full reconstruction from the beginning of a profile's history must be possible and must produce a result equivalent to the currently-stored latest version | Downstream consumers must tolerate additive shape changes to the projection without breaking; a breaking change requires a new projection version namespace, not an in-place redefinition |
| R-01…R-16 Reference data | `TaxonomyEntryPublished`, `TaxonomyEntryDeprecated`, `TaxonomyVersionPublished` | Academic Taxonomy Context | Every other bounded context; every downstream runtime that renders taxonomy-driven UI | A governance-approved reference-data change | Strictly ordered globally (Taxonomy Version is a single, global sequence) | Publishing an identical entry twice is a no-op | Directly replayable; historical resolution always targets a specific past Taxonomy Version | Deprecation is always additive (marks inactive, never removes); this is the taxonomy-layer expression of the same additive-only discipline applied everywhere else in this model |

---

## PART 12 — Projection Model

| Projection | Purpose | Source Entities | Refresh Model | Ownership | Consumers |
|---|---|---|---|---|---|
| **Academic Context** (E-10) | Compose the full current academic picture of one student from all operational/historical/derived entities in this domain | E-01, E-02, E-03, E-04, E-05, E-06, E-07, E-08 | Event-driven, rebuilt on any relevant source event; logically a full rebuild every time (Part 3, E-10) | Academic Context Composition Context (this domain) | Student Context Runtime, and transitively every projection below |
| **Student Context** | Compose the full cross-domain student picture (academic + career + professional + personalization) | Academic Context (this domain), plus equivalent projections from other domains (outside this WP's scope) | Event-driven, rebuilt on any relevant source-domain event | Student Context Runtime (outside this domain; consumes this domain's Academic Context as one input) | Knowledge Runtime |
| **Knowledge Runtime projection** | Compose Student Context with broader platform knowledge (opportunities, market data, etc.) for use by reasoning/recommendation systems | Student Context, plus non-academic knowledge sources (outside this domain's scope) | Event-driven or on-demand, per Knowledge Runtime's own design (outside this WP) | Knowledge Runtime | Recommendation Engine, Decision Engine, AI Context Generation |
| **Recommendation projection** | The specific slice of composed knowledge a recommendation computation consumes for one request | Knowledge Runtime projection | On-demand, per recommendation request | Recommendation Engine (outside this domain) | End-user-facing recommendation output; Decision Engine |
| **Decision projection** | The specific slice of composed knowledge plus recommendation output a decision computation consumes | Knowledge Runtime projection, Recommendation projection | On-demand, per decision request | Decision Engine (outside this domain) | Career Intelligence |
| **Career Intelligence projection** | Compose decision output with Derived Academic Signals (E-09) and career-domain data for career-path intelligence | Decision projection, E-09 Derived Academic Signal | Event-driven and on-demand hybrid | Career Intelligence (outside this domain; consumes this domain's E-09 directly, per WP-ARCH-01B Part 5 step 12) | Career Outcome Intelligence Engine, AI Context Generation |
| **Career Outcome projection** | Longitudinal view of academic-to-career outcomes over time | Career Intelligence projection, plus direct read of immutable E-05 Academic Record history (the justified exception, Part 5 step 13) | Periodic/batch recompute, given its longitudinal nature, plus on-demand for specific queries | Career Outcome Intelligence Engine (outside this domain) | Enterprise reporting, future capabilities |
| **FYUGP projection** | Slice of Academic Context relevant to undergraduate-program matching (qualification, stream, level) | Academic Context (E-10) | Event-driven, on `AcademicContextRefreshed` | FYUGP Intelligence (outside this domain) | End-user-facing program-matching output |
| **AI Context projection** | The final, fully-provenanced bundle assembled for LLM-facing generation | Knowledge Runtime projection, Career Intelligence projection, E-09 Derived Academic Signal (directly) | On-demand, generated fresh per request, never persisted as truth (Part 7's "AI context" row) | AI Context Generation (outside this domain) | End-user-facing AI-generated content |

**Common rule across all nine projections:** every projection in this table either is, or is built from, the Academic Context (E-10) — none of them, at any point in the chain, reads E-01 through E-09 directly. This is the projection-layer enforcement of the read-model discipline established in WP-ARCH-01B ADR-06 and Part 10's cross-cutting permission rule.

---

## PART 13 — Cross-Domain Mapping

| Connected Domain | Direction | Ownership | Data Exchanged | Synchronization | Events |
|---|---|---|---|---|---|
| **Student Onboarding** | Inbound (commands into this domain) | Onboarding owns the workflow/UI; this domain owns all resulting data | Commands to establish/update E-01, start E-03, set E-04, commit E-05 | Synchronous command/response for each step, per the existing, evidence-confirmed step-by-step onboarding pattern (WP-ARCH-01A.2 §2.1–2.3) | This domain publishes `AcademicProfileEstablished`, `QualificationStarted`, `SubjectSelected`, `AcademicRecordCommitted` etc. back to Onboarding for step-progression purposes |
| **Student Context Runtime** | Outbound (this domain publishes) | This domain owns Academic Context; Student Context Runtime owns the merged cross-domain view | Academic Context (E-10), in full | Event-driven (`AcademicContextRefreshed`) | Consumes `AcademicContextRefreshed` |
| **Knowledge Runtime** | Outbound (indirect, via Student Context Runtime) | This domain owns nothing at this layer; strictly downstream | Composed knowledge including this domain's Academic Context as one input | Per Knowledge Runtime's own refresh model | Consumes Student Context Runtime's own published events |
| **Recommendation Engine** | Outbound (indirect, via Knowledge Runtime) | This domain owns nothing at this layer | No direct exchange — receives only what Knowledge Runtime composes | N/A at this domain's boundary | None directly from this domain |
| **Decision Engine** | Outbound (indirect, via Recommendation Engine / Knowledge Runtime) | This domain owns nothing at this layer | Same as Recommendation Engine | N/A | None directly |
| **Career Intelligence** | Outbound (two paths: indirect via Decision Engine, and direct for Derived Signals) | This domain owns E-09 Derived Academic Signal; Career Intelligence owns its own composition | E-09 instances, read-only, always version-referenced | Event-driven (`DerivedSignalComputed`) for the direct path | Consumes `DerivedSignalComputed` |
| **Career Outcome Intelligence Engine** | Outbound (two paths: indirect via Career Intelligence, and direct for immutable performance history) | This domain owns E-05/E-06; Career Outcome Intelligence Engine owns longitudinal analysis | Read-only access to committed `AcademicRecord` history (the one justified direct-history exception) | Batch/periodic, given the longitudinal use case | Consumes `AcademicRecordCommitted`/`AcademicRecordAmended` directly for this one integration only |
| **Education Intelligence** | N/A — absorbed | Per WP-ARCH-01B Part 8, this module's responsibilities are fully distributed across this domain's contexts; it does not persist as a separate integration point in the target architecture | N/A | N/A | N/A |
| **FYUGP Intelligence** | Outbound (via Academic Context directly) | This domain owns Academic Context; FYUGP Intelligence owns program-matching logic | Qualification/stream/level slice of Academic Context | Event-driven (`AcademicContextRefreshed`) | Consumes `AcademicContextRefreshed` |
| **AI Context Generation** | Outbound (indirect via Knowledge Runtime and Career Intelligence, plus direct for Derived Signals) | This domain owns E-09 and, transitively, E-10; AI Context Generation owns final bundle assembly and provenance stamping | Derived Academic Signals (direct), Academic Context (indirect via Knowledge Runtime) | Event-driven plus on-demand generation | Consumes `DerivedSignalComputed`; indirectly consumes `AcademicContextRefreshed` via Knowledge Runtime |

---

## PART 14 — Enterprise Governance Rules

1. **Canonical ownership principle.** Every business concept has exactly one bounded context that may create or mutate it. This document's Part 2 and Part 4 are the enforcement mechanism: no entity appears twice under two different canonical owners.
2. **Single writer principle.** For every entity in Parts 3–4, exactly one command surface (named per-entity in Part 10) may write to it. No downstream runtime, AI system, or projection ever writes to a Part 3 entity — this is absolute, with the sole documented exception being amendment/correction flows, which are still issued through the same single command surface, never through a side channel.
3. **Reference data governance.** All changes to R-01 through R-15 go through a taxonomy stewardship process that publishes a new R-16 Taxonomy Version; no reference entry is ever edited in place, and no entity outside the Academic Taxonomy Context may create or modify reference data.
4. **Aggregate evolution rules.** New attributes may be added to any entity in Part 4 as optional, defaulted fields without breaking existing consumers. Removing or repurposing an existing required attribute, or changing an entity's aggregate boundary (e.g. moving a child entity to a different parent), is a breaking change requiring a new WP-ARCH-01B-level architectural decision, not a routine data-model update — this document is not authorized to make that call unilaterally in a future revision.
5. **Version compatibility.** Every event in Part 11 must remain a superset-compatible extension of its own prior shape; consumers must be built to ignore unrecognized additive fields. A genuinely incompatible change requires a new event name, never a redefinition of an existing one — directly extending the "never remove enum values" discipline WP-ARCH-01A found already present in the legacy schema's own migration comments into a domain-wide rule.
6. **Projection rebuild rules.** Every projection in Part 12 must be fully reconstructable from its declared source entities/events alone; no projection may depend on hidden state, manual correction, or any input not traceable to Part 11's event list. This is what makes replay (Part 8) a real guarantee rather than an aspiration.
7. **Backward compatibility.** A Taxonomy Version publish, an event-shape extension, or a projection rebuild must never invalidate a historical entity's ability to be read and correctly interpreted — every historical entity carries the specific Taxonomy Version it was created against precisely so that later taxonomy evolution cannot retroactively corrupt its meaning.
8. **Deprecation policy.** Deprecation (of a taxonomy entry, an event shape, or a projection version) always means "no longer available for new writes," never "removed from the record of what already happened." This applies uniformly across Parts 6, 7, 8, and 11 — it is stated once here as the single governing rule those sections each apply in their own context.
9. **Data stewardship.** Each bounded context's canonical owner (Part 2) is the accountable steward for that context's entities' data quality, including resolving any future ambiguity the way Part 4 of WP-ARCH-01B resolved the six ambiguities inherited from WP-ARCH-01A.2 — by explicit decision, not by whichever system happens to write to it first.
10. **Enterprise naming standards.** Entity names are singular, PascalCase business nouns (`AcademicQualification`, not `academic_qualifications` or `AcademicQualifications`); attribute business names are plain-English phrases, not abbreviations or implementation-derived names (`Marks Obtained`, not `marks_obtained` or `mrks`); event names are past-tense business facts (`AcademicRecordCommitted`, not `UpdateRecord` or `RecordCommit`) — this standard is applied consistently across every Part of this document and is binding on every future implementation named in the Expected Outcome.
