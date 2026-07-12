# ADR-009: Enterprise Event Bus Architecture

**Status:** Proposed\
**Target Phase:** Phase 3

## Context

Platform growth requires asynchronous communication between services and
background workers.

## Decision

Adopt an Enterprise Event Bus architecture using domain events for
integration and automation.

## Benefits

-   Loose coupling
-   Improved scalability
-   Reliable background processing
-   Better observability

## Example Events

-   ResumeUploaded
-   AssessmentCompleted
-   SkillGapCalculated
-   CareerRecommendationGenerated
