'use strict';

/**
 * @file src/services/cvTemplates.helper.js
 * @description
 * Immutable CV template prompt registry.
 *
 * Optimized for:
 * - deterministic strict JSON schema
 * - normalized template lookup
 * - immutable exports
 * - future template scalability
 */

// ─────────────────────────────────────────────────────────────
// Shared JSON schema contract
// ─────────────────────────────────────────────────────────────
const STRICT_JSON_SCHEMA = `Return STRICT JSON ONLY:
{
  "optimizedSummary": "...",
  "extractedJobKeywords": [],
  "highlightedSkills": [],
  "reorderedExperience": [],
  "keywordMatchScore": 0,
  "optimizationNotes": []
}`;

// ─────────────────────────────────────────────────────────────
// Template registry
// ─────────────────────────────────────────────────────────────
const TEMPLATE_PROMPTS = Object.freeze({
  modern: `
You are an expert resume writer.

Create a modern, ATS-optimized CV tailored to the job description.

${STRICT_JSON_SCHEMA}
`,

  professional: `
You are a professional resume consultant.

Write a clean, corporate-style CV tailored to the target role.
Prioritize executive clarity, ATS readability, and measurable impact.

${STRICT_JSON_SCHEMA}
`,

  creative: `
You are a creative resume designer.

Make the CV engaging and visually differentiated while preserving ATS compatibility and professionalism.

${STRICT_JSON_SCHEMA}
`,
});

const TEMPLATE_LABELS = Object.freeze({
  modern: 'Modern',
  professional: 'Professional',
  creative: 'Creative',
});

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function normalizeTemplateId(templateId) {
  return String(templateId || 'modern')
    .trim()
    .toLowerCase();
}

function getTemplatePrompt(templateId = 'modern') {
  const normalized = normalizeTemplateId(templateId);
  return (
    TEMPLATE_PROMPTS[normalized] ||
    TEMPLATE_PROMPTS.modern
  );
}

function getTemplateLabel(templateId = 'modern') {
  const normalized = normalizeTemplateId(templateId);
  return (
    TEMPLATE_LABELS[normalized] ||
    TEMPLATE_LABELS.modern
  );
}

function listSupportedTemplates() {
  return Object.keys(TEMPLATE_PROMPTS);
}

module.exports = {
  TEMPLATE_PROMPTS,
  TEMPLATE_LABELS,
  getTemplatePrompt,
  getTemplateLabel,
  listSupportedTemplates,
};