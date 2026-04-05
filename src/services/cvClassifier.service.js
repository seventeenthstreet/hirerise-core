'use strict';

/**
 * @file src/services/cvClassifier.service.js
 * @description
 * Two-layer CV document classifier.
 *
 * Optimized for:
 * - deterministic heuristic scoring
 * - resilient AI JSON parsing
 * - safer Anthropic client loading
 * - bounded confidence normalization
 * - empty-text handling
 */

const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────
const DEFAULT_MODEL =
  process.env.CV_CLASSIFIER_MODEL ||
  process.env.CV_EXTRACT_MODEL ||
  'claude-haiku-4-5-20251001';

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

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function normalizeText(text) {
  return String(text || '').trim();
}

function stripJson(text = '') {
  return String(text)
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function uniqueStrings(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function getAnthropicClient() {
  if (process.env.NODE_ENV === 'test') {
    return null;
  }

  try {
    return require('../config/anthropic.client');
  } catch (err) {
    logger.warn('[CvClassifier] Anthropic client unavailable', {
      error: err?.message || 'Unknown client load error',
    });
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Heuristic signals
// ─────────────────────────────────────────────────────────────
const HEURISTIC_SIGNALS = [
  {
    name: 'contact_info',
    section: 'contact',
    test: (text) =>
      /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(text) ||
      /(\+?\d[\s\-()]{0,3}){7,15}/.test(text),
  },
  {
    name: 'person_name',
    section: 'personal',
    test: (text) =>
      /^[\s\S]{0,200}[A-Z][a-z]+ [A-Z][a-z]+/.test(text),
  },
  {
    name: 'work_experience',
    section: 'experience',
    test: (text) =>
      /\b(experience|employment|work history|career history|professional background|worked at|positions? held|job history)\b/i.test(
        text
      ),
  },
  {
    name: 'education',
    section: 'education',
    test: (text) =>
      /\b(education|academic|degree|bachelor|master|phd|diploma|university|college|school|qualification)\b/i.test(
        text
      ),
  },
  {
    name: 'skills',
    section: 'skills',
    test: (text) =>
      /\b(skills?|competenc(y|ies)|proficien(t|cy)|expertise|technologies|tools|languages)\b/i.test(
        text
      ),
  },
  {
    name: 'professional_structure',
    section: 'structure',
    test: (text) =>
      /\b(20\d{2}|19\d{2})\b.{0,40}\b(20\d{2}|present|current|now)\b/i.test(
        text
      ) ||
      /\b(responsible for|managed|led|developed|designed|implemented|achieved|coordinated)\b/i.test(
        text
      ),
  },
];

const REJECTION_SIGNALS = [
  {
    test: (text) =>
      /\b(invoice|bill to|payment due|subtotal|total amount|vat|tax id)\b/i.test(
        text
      ),
    type: 'invoice',
  },
  {
    test: (text) =>
      /\b(dear (hiring manager|sir|madam|recruiter)|i am writing to apply|please find my|enclosed (herewith|please find))\b/i.test(
        text
      ),
    type: 'cover_letter',
  },
  {
    test: (text) =>
      /\b(lorem ipsum|dolor sit amet)\b/i.test(text),
    type: 'random_document',
  },
  {
    test: (text) => text.split(/\s+/).length < 40,
    type: 'random_document',
  },
];

// ─────────────────────────────────────────────────────────────
// Heuristic engine
// ─────────────────────────────────────────────────────────────
function runHeuristics(text) {
  const safeText = normalizeText(text);

  for (const signal of REJECTION_SIGNALS) {
    if (signal.test(safeText)) {
      return {
        score: 0,
        detectedSections: [],
        rejectionType: signal.type,
      };
    }
  }

  const detectedSections = [];
  let score = 0;

  for (const signal of HEURISTIC_SIGNALS) {
    if (signal.test(safeText)) {
      score += 1;
      detectedSections.push(signal.section);
    }
  }

  return {
    score,
    detectedSections: uniqueStrings(detectedSections),
    rejectionType: null,
  };
}

// ─────────────────────────────────────────────────────────────
// AI classifier
// ─────────────────────────────────────────────────────────────
async function runAiClassifier(text) {
  const anthropic = getAnthropicClient();

  if (!anthropic) {
    throw new Error('Anthropic client unavailable');
  }

  const sample = normalizeText(text).slice(0, 3000);

  const response = await anthropic.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 256,
    system: CLASSIFIER_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Document text:\n\n${sample}`,
      },
    ],
  });

  const raw = (response?.content || [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('');

  const parsed = JSON.parse(stripJson(raw));

  return {
    is_cv: Boolean(parsed?.is_cv),
    confidence: clamp(Number(parsed?.confidence) || 0, 0, 100),
    document_type: parsed?.document_type || 'other',
    reason: parsed?.reason || 'AI classification completed.',
    detected_sections: uniqueStrings(
      parsed?.detected_sections || []
    ),
  };
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────
async function classifyDocument(text, { skipAi = false } = {}) {
  const safeText = normalizeText(text);

  if (!safeText) {
    return {
      is_cv: false,
      confidence: 98,
      document_type: 'random_document',
      reason: 'Document is empty or unreadable.',
      detected_sections: [],
    };
  }

  const {
    score,
    detectedSections,
    rejectionType,
  } = runHeuristics(safeText);

  // clear CV
  if (score >= 4) {
    return {
      is_cv: true,
      confidence: clamp(60 + score * 7, 0, 95),
      document_type: 'cv',
      reason: `Document contains ${score} CV structural signals including ${detectedSections.join(
        ', '
      )}.`,
      detected_sections: detectedSections,
    };
  }

  // hard rejection
  if (rejectionType) {
    const labels = {
      invoice: 'invoice',
      cover_letter: 'cover letter',
      random_document: 'unstructured document',
    };

    return {
      is_cv: false,
      confidence: 92,
      document_type: rejectionType,
      reason: `Document appears to be a ${
        labels[rejectionType] || rejectionType
      }, not a CV.`,
      detected_sections: [],
    };
  }

  const aiEnabled =
    !skipAi &&
    process.env.ENABLE_AI_CV_CLASSIFIER !== 'false';

  if (aiEnabled) {
    try {
      const aiResult = await runAiClassifier(safeText);

      return {
        is_cv: aiResult.is_cv,
        confidence: aiResult.confidence,
        document_type: aiResult.document_type,
        reason: aiResult.reason,
        detected_sections: uniqueStrings([
          ...aiResult.detected_sections,
          ...detectedSections,
        ]),
      };
    } catch (err) {
      logger.warn(
        '[CvClassifier] AI failed, using heuristics fallback',
        {
          error: err?.message || 'Unknown AI error',
        }
      );
    }
  }

  const isCV = score >= 3;

  return {
    is_cv: isCV,
    confidence: isCV ? 55 : 65,
    document_type: isCV ? 'cv' : 'other',
    reason: isCV
      ? `Detected ${score} CV signals: ${detectedSections.join(
          ', '
        )}.`
      : `Only ${score} of 6 CV signals detected — document may not be a resume.`,
    detected_sections: detectedSections,
  };
}

module.exports = {
  classifyDocument,
};