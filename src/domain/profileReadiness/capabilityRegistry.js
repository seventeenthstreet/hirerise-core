'use strict';

/**
 * @file src/domain/profileReadiness/capabilityRegistry.js
 *
 * WP-SPCE-02A — Capability Registry Foundation Implementation
 * WP-SPCE-02B — Capability Registry Expression Enhancement
 *
 * Declarative required-field map per downstream capability, per the design
 * frozen in WP-SPCE-01D §4 ("Capability Registry Design"), extended in
 * WP-SPCE-02B to support AND/OR expression trees instead of only a flat
 * AND-of-fields list.
 *
 * This module is pure data plus a handful of accessors. It contains no
 * profile-evaluation logic and MUST NOT import readinessEngine.js — the
 * dependency direction is one-way (readinessEngine -> capabilityRegistry),
 * per WP-SPCE-01D §9 ("Repository Standards / Dependency direction").
 *
 * Field paths are dot-path strings resolved against the canonical
 * Professional Profile shape defined in
 * ../professionalProfile/professionalProfile.schema.js
 * (see emptyProfessionalProfile()) — never against raw onboarding_progress
 * or user_profiles table columns, which use a different, non-canonical
 * shape. Consumers integrating this registry in a future work package are
 * responsible for mapping whatever raw row shape they read into this
 * canonical shape before calling the Readiness Engine; this module does not
 * do that mapping.
 *
 * ── EXPRESSION MODEL (WP-SPCE-02B) ─────────────────────────────────────
 *
 * A capability's requirements are declared one of two ways:
 *
 *   1. Legacy flat form (unchanged since WP-SPCE-02A, still fully
 *      supported, no rewrite required):
 *        requiredFields: ['a', 'b', 'c']
 *      Interpreted as an implicit AND group: { all: ['a', 'b', 'c'] }.
 *
 *   2. Expression form (new in WP-SPCE-02B), for capabilities whose real
 *      business rule is not a flat AND:
 *        requires: Expression
 *
 *   Expression =
 *       string                        // a leaf field path
 *     | { all: Expression[] }         // AND group — every child must be satisfied
 *     | { any: Expression[] }         // OR group — at least one child must be satisfied
 *
 *   Groups may nest arbitrarily. A definition must declare exactly one of
 *   `requiredFields` or `requires` — never both, never neither (enforced by
 *   validateRegistry()). No other operators exist; this is deliberately the
 *   smallest expression model that can represent AND/OR/nesting — no rule
 *   scripting, no custom expression language, no runtime-evaluated code, per
 *   WP-SPCE-02B's explicit "avoid unnecessary complexity" instruction.
 *
 * WHY TWO OF THE FIVE CAPABILITIES ARE STILL PARTIAL APPROXIMATIONS EVEN
 * AFTER THIS ENHANCEMENT (read before "fixing" these entries further):
 *
 *   `career_report` is now a FULLY faithful expression of the real rule in
 *   onboarding.careerReport.service.js#generateCareerReport: (education OR
 *   experience) AND expectedRoleIds. Verified directly against that
 *   function's precondition checks (WP-SPCE-02B investigation) — both
 *   `education`/`experience` and `expected_role_ids` are populated by the
 *   canonical write path (professionalProfile.repository.js) independently
 *   of career report generation, so there is no ordering/circularity issue.
 *
 *   `professional_onboarding_completion` is now a MORE faithful but still
 *   PARTIAL expression of onboarding.helpers.js#evaluateCompletion, which
 *   has three independent tracks (trackA || trackAUpload || trackB). This
 *   registry entry expresses trackB only:
 *     - trackB: (experience OR education) AND expectedRoleIds — expressible
 *       and verified non-circular, same reasoning as career_report above.
 *     - trackA requires `progress.career_report` — a flag recording that a
 *       Career Report has *already been generated*, not a fact about
 *       profile data completeness. This is structurally outside what a
 *       readiness-registry field-presence model can or should express: it
 *       is a process-completion signal, not a data-presence signal.
 *     - trackAUpload requires `progress.cv_resume_id` (raw onboarding
 *       column) AND `personal_details.full_name`. `cv_resume_id`'s closest
 *       canonical-schema analogue is `resumeMetadata.resumeId`
 *       (`professionalProfile.repository.js` reads
 *       `row.latest_resume_id ?? row.resume_id` into it) — but tracing the
 *       actual write paths (WP-SPCE-02B investigation) found no writer that
 *       populates `latest_resume_id` independently of onboarding completion
 *       already being determined: the only writer is
 *       `onboarding.helpers.js`'s own completion-time sync
 *       (`progressData.cv_resume_id -> latest_resume_id`), which fires
 *       *after* `evaluateCompletion()` has already used the raw
 *       `cv_resume_id` field to decide completion. Using
 *       `resumeMetadata.resumeId` as a readiness precondition would
 *       therefore be circular — always false before completion, since
 *       nothing populates it before completion. It is excluded for this
 *       specific, evidenced reason, not merely deferred for convenience.
 *
 *   Both exclusions make this entry STRICTER than the real rule (a user who
 *   completed via trackA or trackAUpload alone will show as "not ready"
 *   here), never LOOSER — the same safe-direction principle WP-SPCE-02A
 *   established. WP-SPCE-03B's output-diff step (WP-SPCE-01C §10) is where
 *   this gap must be resolved or explicitly accepted before any real
 *   consumer switches over; it is not resolved by this work package, which
 *   is registry-only per its own scope.
 *
 * This is a PURE data-shape module — no I/O, no DB, no HTTP, no logging,
 * matching the "no runtime overhead" requirement in WP-SPCE-01D §4/§10.
 */

const { emptyProfessionalProfile } = require('../professionalProfile/professionalProfile.schema');

/**
 * Stable, business-meaningful capability identifiers.
 * Treat as a public contract once shipped — renaming a value here is a
 * breaking change for anything that has logged or persisted it (see
 * WP-SPCE-01D §4, "Capability identifier format").
 *
 * @enum {string}
 */
const CAPABILITY_IDS = Object.freeze({
  PROFESSIONAL_ONBOARDING_COMPLETION: 'professional_onboarding_completion',
  CAREER_REPORT:                      'career_report',
  RESUME_GENERATOR:                   'resume_generator',
  JOB_MATCHING:                       'job_matching',
  CHI_SCORE:                          'chi_score',
});

/**
 * @typedef {string | {all: Expression[]} | {any: Expression[]}} Expression
 */

/**
 * @typedef {object} CapabilityDefinition
 * @property {string} id                    - matches its own key in CAPABILITIES
 * @property {string} description           - human-readable, one sentence
 * @property {string[]} [requiredFields]    - legacy flat-AND form (mutually
 *                                             exclusive with `requires`)
 * @property {Expression} [requires]        - expression-tree form (mutually
 *                                             exclusive with `requiredFields`)
 * @property {string} addedIn               - work package that introduced it
 */

/** @type {Object<string, CapabilityDefinition>} */
const CAPABILITIES = Object.freeze({
  [CAPABILITY_IDS.PROFESSIONAL_ONBOARDING_COMPLETION]: Object.freeze({
    id: CAPABILITY_IDS.PROFESSIONAL_ONBOARDING_COMPLETION,
    description:
      'Professional Onboarding completion, Track B only: (experience OR ' +
      'education) AND an expected role. Tracks A and A-Upload are ' +
      'deliberately not expressible here — see the file header ' +
      '"WHY TWO OF THE FIVE CAPABILITIES..." section for the evidenced ' +
      'reason for each. This makes evaluate() stricter than the real ' +
      'rule, never looser.',
    requires: Object.freeze({
      all: Object.freeze([
        Object.freeze({ any: Object.freeze(['experience', 'education']) }),
        'careerGoals.expectedRoleIds',
      ]),
    }),
    addedIn: 'WP-SPCE-02A',
  }),

  [CAPABILITY_IDS.CAREER_REPORT]: Object.freeze({
    id: CAPABILITY_IDS.CAREER_REPORT,
    description:
      'Career Report generation precondition, fully faithful to ' +
      'onboarding.careerReport.service.js#generateCareerReport: ' +
      '(education OR experience) AND an expected role. Verified ' +
      'non-circular against the canonical write path (WP-SPCE-02B).',
    requires: Object.freeze({
      all: Object.freeze([
        Object.freeze({ any: Object.freeze(['education', 'experience']) }),
        'careerGoals.expectedRoleIds',
      ]),
    }),
    addedIn: 'WP-SPCE-02A',
  }),

  [CAPABILITY_IDS.RESUME_GENERATOR]: Object.freeze({
    id: CAPABILITY_IDS.RESUME_GENERATOR,
    description:
      'Minimum data needed to generate a resume/CV. A faithful AND of the ' +
      'documented rule (WP-SPCE-01A §1) — fullName, education, experience ' +
      'are all genuinely required together.',
    requiredFields: Object.freeze([
      'personalInformation.fullName',
      'education',
      'experience',
    ]),
    addedIn: 'WP-SPCE-02A',
  }),

  [CAPABILITY_IDS.JOB_MATCHING]: Object.freeze({
    id: CAPABILITY_IDS.JOB_MATCHING,
    description:
      'Minimum data needed to run job matching. A faithful AND of the ' +
      'documented rule (WP-SPCE-01A §1) — target role, skills, and ' +
      'preferred location are all genuinely required together.',
    requiredFields: Object.freeze([
      'careerGoals.expectedRoleIds',
      'skills',
      'employmentPreferences.preferredWorkLocation',
    ]),
    addedIn: 'WP-SPCE-02A',
  }),

  [CAPABILITY_IDS.CHI_SCORE]: Object.freeze({
    id: CAPABILITY_IDS.CHI_SCORE,
    description:
      'Minimum data needed to compute a Career Health Index score. A ' +
      'faithful AND of the documented rule (WP-SPCE-01A §1) — skills and ' +
      'experience are both genuinely required.',
    requiredFields: Object.freeze([
      'skills',
      'experience',
    ]),
    addedIn: 'WP-SPCE-02A',
  }),
});

/**
 * Look up a capability definition by id.
 *
 * @param {string} capabilityId
 * @returns {CapabilityDefinition}
 * @throws {Error} if capabilityId is not registered — callers needing the
 *   typed UnknownCapabilityError should call readinessEngine.evaluate()
 *   instead of this function directly; this accessor is intentionally
 *   dependency-free (see file header) so it throws a plain Error rather
 *   than importing readinessEngine.js's error class.
 */
function getCapability(capabilityId) {
  const definition = CAPABILITIES[capabilityId];
  if (!definition) {
    throw new Error(`Unknown capability id: "${capabilityId}"`);
  }
  return definition;
}

/**
 * @returns {string[]} every registered capability id, in declaration order.
 */
function listCapabilityIds() {
  return Object.keys(CAPABILITIES);
}

/**
 * Normalizes a CapabilityDefinition into its Expression form, regardless of
 * whether it was authored using the legacy `requiredFields` flat form or
 * the new `requires` expression-tree form. This is the single place that
 * understands "what does a definition actually require" — both
 * validateRegistry() and readinessEngine.js's evaluate() call this rather
 * than each re-deriving the same normalization.
 *
 * @param {CapabilityDefinition} definition
 * @returns {Expression}
 */
function toExpression(definition) {
  if (definition.requires !== undefined) {
    return definition.requires;
  }
  return { all: definition.requiredFields };
}

/**
 * Convenience wrapper: look up a capability by id and return its normalized
 * Expression in one call. readinessEngine.js uses this exclusively rather
 * than reaching into CAPABILITIES directly.
 *
 * @param {string} capabilityId
 * @returns {Expression}
 * @throws {Error} if capabilityId is not registered (see getCapability())
 */
function getCapabilityExpression(capabilityId) {
  return toExpression(getCapability(capabilityId));
}

// ─────────────────────────────────────────────────────────────────────────
// Registry self-validation (WP-SPCE-01D §4 "Validation rules" / §10;
// expanded in WP-SPCE-02B to validate expression trees).
//
// Intentionally NOT invoked at module load — this module introduces zero
// runtime overhead, per this work package's explicit requirement. It is
// invoked only from capabilityRegistry.test.js, i.e. at test/CI time.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Resolves whether a dot-path exists as a defined key in a given object
 * shape (structural existence — does NOT check for a non-empty value; that
 * is readinessEngine.js's job on a real profile, not this module's).
 *
 * @param {object} shape
 * @param {string} path
 * @returns {boolean}
 */
function _pathExistsInShape(shape, path) {
  const segments = path.split('.');
  let cursor = shape;

  for (const segment of segments) {
    if (cursor === null || typeof cursor !== 'object' || !(segment in cursor)) {
      return false;
    }
    cursor = cursor[segment];
  }

  return true;
}

/**
 * Recursively validates one Expression node.
 *
 * Checks performed (per WP-SPCE-02B "Registry Validation"):
 *   - leaf strings are non-empty and resolve against the canonical schema
 *   - group nodes use exactly one recognized operator ("all" or "any"),
 *     never both in the same node, never an unrecognized operator
 *   - group children are a non-empty array
 *   - anything else (not a string, not a well-formed group object) is a
 *     malformed node
 *
 * @param {*} expr
 * @param {object} canonicalShape
 * @param {string} contextLabel - human-readable path to this node, for
 *   error messages (e.g. `"career_report".requires.all[0]`)
 * @returns {string[]} errors (empty array if this node and all descendants are valid)
 */
function _validateExpression(expr, canonicalShape, contextLabel) {
  const errors = [];

  if (typeof expr === 'string') {
    if (expr.length === 0) {
      errors.push(`${contextLabel}: empty field path.`);
      return errors;
    }
    if (!_pathExistsInShape(canonicalShape, expr)) {
      errors.push(
        `${contextLabel}: field path "${expr}" does not resolve against ` +
        `professionalProfile.schema.js.`
      );
    }
    return errors;
  }

  if (expr !== null && typeof expr === 'object' && !Array.isArray(expr)) {
    const keys = Object.keys(expr);
    const operatorKeys = keys.filter((k) => k === 'all' || k === 'any');
    const unknownKeys = keys.filter((k) => k !== 'all' && k !== 'any');

    if (unknownKeys.length > 0) {
      errors.push(`${contextLabel}: unknown operator(s): ${unknownKeys.join(', ')}.`);
    }

    if (operatorKeys.length === 0) {
      errors.push(`${contextLabel}: expression object must declare "all" or "any".`);
      return errors;
    }

    if (operatorKeys.length > 1) {
      errors.push(`${contextLabel}: expression object must not mix "all" and "any" in the same node.`);
    }

    for (const opKey of operatorKeys) {
      const children = expr[opKey];
      if (!Array.isArray(children) || children.length === 0) {
        errors.push(`${contextLabel}.${opKey}: group must be a non-empty array.`);
        continue;
      }
      children.forEach((child, index) => {
        errors.push(..._validateExpression(child, canonicalShape, `${contextLabel}.${opKey}[${index}]`));
      });
    }

    return errors;
  }

  errors.push(
    `${contextLabel}: malformed expression node — must be a field-path ` +
    `string or an {all:[...]} / {any:[...]} group.`
  );
  return errors;
}

/**
 * Validates every capability definition in the registry against the
 * canonical Professional Profile shape and against structural expectations
 * for a well-formed CapabilityDefinition, including full expression-tree
 * validation (WP-SPCE-02B).
 *
 * Checks performed:
 *   - every definition declares exactly one of `requiredFields` / `requires`
 *   - every field path (in either form) resolves against
 *     professionalProfile.schema.js
 *   - expression trees have valid operators, no malformed/empty groups,
 *     no mixed operators in a single node
 *   - no duplicate capability ids across distinct registry keys
 *   - no malformed definitions (missing id/description/addedIn)
 *
 * Accepts an optional `registry` override (defaulting to the real,
 * shipped CAPABILITIES) purely so capabilityRegistry.test.js can exercise
 * every failure branch against deliberately malformed fixture registries
 * without needing to mutate the real, frozen CAPABILITIES export. Calling
 * validateRegistry() with no argument — the only way this function is ever
 * invoked outside of tests — always validates the real registry.
 *
 * @param {Object<string, CapabilityDefinition>} [registry=CAPABILITIES]
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateRegistry(registry = CAPABILITIES) {
  const errors = [];
  const canonicalShape = emptyProfessionalProfile(null);
  const seenIds = new Set();

  for (const [key, definition] of Object.entries(registry)) {
    if (!definition || typeof definition !== 'object') {
      errors.push(`Registry entry "${key}" is not a valid definition object.`);
      continue;
    }

    if (typeof definition.id !== 'string' || definition.id.length === 0) {
      errors.push(`Registry entry "${key}" is missing a valid "id" field.`);
    } else {
      if (definition.id !== key) {
        errors.push(
          `Registry entry "${key}" has a mismatched id: "${definition.id}".`
        );
      }
      // Checked independently of the key-match above: two different
      // registry keys could each declare the same `id` value even if one
      // or both mismatch their own key. Object keys are already unique by
      // construction, so this is the only way a real duplicate-id bug
      // (e.g. a copy/paste that changed the key but not the id) would
      // otherwise slip past the key-match check above.
      if (seenIds.has(definition.id)) {
        errors.push(`Duplicate capability id detected: "${definition.id}".`);
      } else {
        seenIds.add(definition.id);
      }
    }

    if (typeof definition.description !== 'string' || definition.description.length === 0) {
      errors.push(`Registry entry "${key}" is missing a valid "description" field.`);
    }

    if (typeof definition.addedIn !== 'string' || definition.addedIn.length === 0) {
      errors.push(`Registry entry "${key}" is missing a valid "addedIn" field.`);
    }

    const hasRequiredFields = definition.requiredFields !== undefined;
    const hasRequires = definition.requires !== undefined;

    if (hasRequiredFields && hasRequires) {
      errors.push(
        `Registry entry "${key}" declares both "requiredFields" and ` +
        `"requires" — a definition must use exactly one.`
      );
      continue;
    }

    if (!hasRequiredFields && !hasRequires) {
      errors.push(
        `Registry entry "${key}" declares neither "requiredFields" nor ` +
        `"requires" — a definition must use exactly one.`
      );
      continue;
    }

    if (hasRequiredFields) {
      if (!Array.isArray(definition.requiredFields) || definition.requiredFields.length === 0) {
        errors.push(`Registry entry "${key}" must declare a non-empty "requiredFields" array.`);
        continue;
      }
      for (const fieldPath of definition.requiredFields) {
        if (typeof fieldPath !== 'string' || fieldPath.length === 0) {
          errors.push(`Registry entry "${key}" has a non-string/empty field path.`);
          continue;
        }
        if (!_pathExistsInShape(canonicalShape, fieldPath)) {
          errors.push(
            `Registry entry "${key}" declares required field "${fieldPath}", ` +
            `which does not resolve against professionalProfile.schema.js.`
          );
        }
      }
    } else {
      errors.push(..._validateExpression(definition.requires, canonicalShape, `"${key}".requires`));
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = Object.freeze({
  CAPABILITY_IDS,
  CAPABILITIES,
  getCapability,
  listCapabilityIds,
  toExpression,
  getCapabilityExpression,
  validateRegistry,
});
