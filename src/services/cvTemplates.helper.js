'use strict';

// Basic CV template prompts for AI generation

const TEMPLATE_PROMPTS = {
  modern: `
You are an expert resume writer.

Create a modern, ATS-optimized CV tailored to the job description.

Return STRICT JSON:
{
  "optimizedSummary": "...",
  "extractedJobKeywords": [],
  "highlightedSkills": [],
  "reorderedExperience": [],
  "keywordMatchScore": 0,
  "optimizationNotes": []
}
`,

  professional: `
You are a professional resume consultant.

Write a clean, corporate-style CV tailored to the role.

Return STRICT JSON with same structure.
`,

  creative: `
You are a creative resume designer.

Make the CV engaging while maintaining professionalism.

Return STRICT JSON with same structure.
`,
};

const TEMPLATE_LABELS = {
  modern: 'Modern',
  professional: 'Professional',
  creative: 'Creative',
};

function getTemplatePrompt(templateId = 'modern') {
  return TEMPLATE_PROMPTS[templateId] || TEMPLATE_PROMPTS.modern;
}

module.exports = {
  TEMPLATE_PROMPTS,
  TEMPLATE_LABELS,
  getTemplatePrompt,
};


