'use strict';

/**
 * cvClassifier.service.js
 *
 * Two-layer CV document classifier.
 *
 * Layer 1 — Regex heuristics (fast, no AI cost, runs first):
 *   Scores the document against 6 structural signals. If the score is
 *   conclusive (≥ 4 signals = clear CV, 0–1 signals = clear reject),
 *   returns immediately without calling the AI.
 *
 * Layer 2 — AI classification (only when heuristics are ambiguous):
 *   Sends the first 3,000 chars to claude-haiku with a strict JSON-only
 *   prompt. Response is parsed and merged with heuristic signals.
 *
 * Return shape (always):
 * {
 *   is_cv:            boolean,
 *   confidence:       0–100,
 *   document_type:    'cv' | 'resume' | 'cover_letter' | 'invoice' | 'random_document' | 'other',
 *   reason:           string,
 *   detected_sections: string[],   // e.g. ['experience', 'education', 'skills']
 * }
 */

const logger = require('../../utils/logger');

// ─── AI system prompt (matches the task spec exactly) ─────────────────────────

const CLASSIFIER_SYSTEM_PROMPT = `You are an AI document classifier.
Your task is to determine whether the provided text is a professional CV/resume.
Analyze deeply — not just keywords.
A valid CV typically includes:
* Personal or contact information
* Work experience or roles
* Skills or competencies
* Education or qualifications
* Structured, professional tone

Now classify the document:
Return JSON ONLY:
{ "is_cv": true/false, "confidence": 0-100, "document_type": "cv" | "resume" | "cover_letter" | "invoice" | "random_document" | "other", "reason": "short explanation", "detected_sections": ["experience", "education", "skills", etc] }

Reject as NOT CV if:
* It is a random document
* It lacks professional structure
* It is a form, invoice, essay, or unrelated text

Be strict but fair.`;

// ─── Layer 1: Regex heuristics ────────────────────────────────────────────────

const HEURISTIC_SIGNALS = [
  {
    name:    'contact_info',
    section: 'contact',
    test:    (text) => /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(text) ||
                       /(\+?\d[\s\-()]{0,3}){7,15}/.test(text),
  },
  {
    name:    'person_name',
    section: 'personal',
    // 2–4 capitalised words in the first 400 chars — typical resume header
    test:    (text) => /^[\s\S]{0,200}[A-Z][a-z]+ [A-Z][a-z]+/.test(text),
  },
  {
    name:    'work_experience',
    section: 'experience',
    test:    (text) => /\b(experience|employment|work history|career history|professional background|worked at|positions? held|job history)\b/i.test(text),
  },
  {
    name:    'education',
    section: 'education',
    test:    (text) => /\b(education|academic|degree|bachelor|master|phd|diploma|university|college|school|qualification)\b/i.test(text),
  },
  {
    name:    'skills',
    section: 'skills',
    test:    (text) => /\b(skills?|competenc(y|ies)|proficien(t|cy)|expertise|technologies|tools|languages)\b/i.test(text),
  },
  {
    name:    'professional_structure',
    section: 'structure',
    // Typical date ranges or role indicators found in CVs
    test:    (text) => /\b(20\d{2}|19\d{2})\b.{0,40}\b(20\d{2}|present|current|now)\b/i.test(text) ||
                       /\b(responsible for|managed|led|developed|designed|implemented|achieved|coordinated)\b/i.test(text),
  },
];

// Signals that strongly indicate NOT a CV
const REJECTION_SIGNALS = [
  { test: (text) => /\b(invoice|bill to|payment due|subtotal|total amount|vat|tax id)\b/i.test(text), type: 'invoice' },
  { test: (text) => /\b(dear (hiring manager|sir|madam|recruiter)|i am writing to apply|please find my|enclosed (herewith|please find))\b/i.test(text), type: 'cover_letter' },
  { test: (text) => /\b(lorem ipsum|dolor sit amet)\b/i.test(text), type: 'random_document' },
  { test: (text) => text.trim().split(/\s+/).length < 40, type: 'random_document' }, // too short
];

/**
 * runHeuristics(text)
 * Returns { score, detectedSections, rejectionType }
 */
function runHeuristics(text) {
  // Check hard rejections first
  for (const sig of REJECTION_SIGNALS) {
    if (sig.test(text)) {
      return { score: 0, detectedSections: [], rejectionType: sig.type };
    }
  }

  const detectedSections = [];
  let score = 0;

  for (const sig of HEURISTIC_SIGNALS) {
    if (sig.test(text)) {
      score++;
      detectedSections.push(sig.section);
    }
  }

  return { score, detectedSections, rejectionType: null };
}

// ─── Layer 2: AI classifier ───────────────────────────────────────────────────

async function runAiClassifier(text) {
  const sample  = text.trim().slice(0, 3000); // first 3000 chars — enough context
  const anthropic = require('../../config/anthropic.client');

  const response = await anthropic.messages.create({
    model:      process.env.CV_CLASSIFIER_MODEL || process.env.CV_EXTRACT_MODEL || 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    system:     CLASSIFIER_SYSTEM_PROMPT,
    messages:   [{ role: 'user', content: `Document text:\n\n${sample}` }],
  });

  const raw   = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  return JSON.parse(clean);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * classifyDocument(text, options)
 *
 * @param {string} text           Extracted plain text from the uploaded file
 * @param {object} [options]
 * @param {boolean} [options.skipAi]  Force heuristics-only (default: false)
 * @returns {Promise<ClassificationResult>}
 */
async function classifyDocument(text, { skipAi = false } = {}) {
  const { score, detectedSections, rejectionType } = runHeuristics(text);

  // ── Conclusive via heuristics — no AI needed ──────────────────────────────

  // Clear CV: ≥ 4 signals
  if (score >= 4) {
    return {
      is_cv:             true,
      confidence:        Math.min(95, 60 + score * 7),
      document_type:     'cv',
      reason:            `Document contains ${score} CV structural signals including ${detectedSections.join(', ')}.`,
      detected_sections: detectedSections,
    };
  }

  // Hard rejection: invoice, cover letter, lorem ipsum
  if (rejectionType) {
    const labels = { invoice: 'invoice', cover_letter: 'cover letter', random_document: 'unstructured document' };
    return {
      is_cv:             false,
      confidence:        92,
      document_type:     rejectionType,
      reason:            `Document appears to be a ${labels[rejectionType] || rejectionType}, not a CV.`,
      detected_sections: [],
    };
  }

  // ── Ambiguous (1–3 signals) — use AI unless disabled ─────────────────────

  const aiEnabled = !skipAi && process.env.ENABLE_AI_CV_CLASSIFIER !== 'false';

  if (aiEnabled) {
    try {
      const aiResult = await runAiClassifier(text);

      // Merge: AI takes priority for document_type/reason; heuristic sections fill gaps
      const mergedSections = [
        ...new Set([...(aiResult.detected_sections || []), ...detectedSections]),
      ];

      return {
        is_cv:             aiResult.is_cv,
        confidence:        aiResult.confidence ?? (aiResult.is_cv ? 72 : 85),
        document_type:     aiResult.document_type || (aiResult.is_cv ? 'cv' : 'other'),
        reason:            aiResult.reason || (aiResult.is_cv ? 'AI classified as CV.' : 'AI classified as non-CV.'),
        detected_sections: mergedSections,
      };
    } catch (aiErr) {
      logger.warn('[CvClassifier] AI classification failed — falling back to heuristics', { error: aiErr.message });
      // Fall through to heuristic-only result
    }
  }

  // ── Heuristic-only fallback (AI disabled or failed) ───────────────────────

  const isCV = score >= 3;
  return {
    is_cv:             isCV,
    confidence:        isCV ? 55 : 65,
    document_type:     isCV ? 'cv' : 'other',
    reason:            isCV
      ? `Detected ${score} CV signals: ${detectedSections.join(', ')}.`
      : `Only ${score} of 6 CV signals detected — document may not be a resume.`,
    detected_sections: detectedSections,
  };
}

module.exports = { classifyDocument };

/**
 * @typedef {Object} ClassificationResult
 * @property {boolean}  is_cv
 * @property {number}   confidence      0–100
 * @property {string}   document_type   'cv' | 'resume' | 'cover_letter' | 'invoice' | 'random_document' | 'other'
 * @property {string}   reason
 * @property {string[]} detected_sections
 */








