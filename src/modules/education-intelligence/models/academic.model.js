'use strict';

/**
 * models/academic.model.js
 *
 * Static reference data for the Education Intelligence module:
 *   SUBJECTS            — full subject catalogue (used for validation)
 *   STREAMS             — stream identifiers
 *   STREAM_SUBJECT_MAP  — subject → stream weight mapping
 *                         (imported by Stream Intelligence Engine in Step 3)
 *   COGNITIVE_DIMENSIONS — cognitive score definitions with engine weights
 *                          (imported by Cognitive Profile Engine in Step 3)
 *
 * This file contains NO Firestore logic. It is a pure config/reference model.
 */

// ─── Subject catalogue ────────────────────────────────────────────────────────

const SUBJECTS = [
  // Core (all streams)
  'Mathematics',
  'English',
  'Second Language',

  // Science / Engineering stream
  'Physics',
  'Chemistry',
  'Biology',
  'Computer Science',

  // Commerce stream
  'Accountancy',
  'Business Studies',
  'Economics',
  'Statistics',

  // Humanities stream
  'History',
  'Geography',
  'Political Science',
  'Sociology',
  'Psychology',
  'Fine Arts',
];

// ─── Stream identifiers ───────────────────────────────────────────────────────

const STREAMS = {
  ENGINEERING: 'engineering',
  MEDICAL:     'medical',
  COMMERCE:    'commerce',
  HUMANITIES:  'humanities',
};

// ─── Stream → subject weight map ─────────────────────────────────────────────
// Each subject's weight represents how strongly its marks influence
// the stream score. Weights within a stream sum to 1.0.
// Used by Stream Intelligence Engine (Step 3).

const STREAM_SUBJECT_MAP = {
  [STREAMS.ENGINEERING]: {
    'Mathematics':      0.35,
    'Physics':          0.30,
    'Chemistry':        0.20,
    'Computer Science': 0.15,
  },
  [STREAMS.MEDICAL]: {
    'Biology':    0.40,
    'Chemistry':  0.30,
    'Physics':    0.20,
    'Mathematics':0.10,
  },
  [STREAMS.COMMERCE]: {
    'Accountancy':     0.30,
    'Economics':       0.30,
    'Business Studies':0.25,
    'Mathematics':     0.15,
  },
  [STREAMS.HUMANITIES]: {
    'History':          0.25,
    'Political Science':0.25,
    'Geography':        0.20,
    'Sociology':        0.15,
    'Psychology':       0.15,
  },
};

// ─── Cognitive dimension definitions ─────────────────────────────────────────
// engine_weight: how much this cognitive dimension influences each stream score.
// Used by Cognitive Profile Engine (Step 3).

const COGNITIVE_DIMENSIONS = [
  {
    key:          'analytical_score',
    label:        'Analytical Thinking',
    description:  'Ability to break down complex problems into logical parts.',
    engine_weight: { engineering: 0.30, medical: 0.25, commerce: 0.20, humanities: 0.15 },
  },
  {
    key:          'logical_score',
    label:        'Logical Reasoning',
    description:  'Pattern recognition and deductive reasoning.',
    engine_weight: { engineering: 0.30, medical: 0.20, commerce: 0.25, humanities: 0.15 },
  },
  {
    key:          'memory_score',
    label:        'Memory & Retention',
    description:  'Ability to retain and recall information accurately.',
    engine_weight: { engineering: 0.15, medical: 0.30, commerce: 0.20, humanities: 0.20 },
  },
  {
    key:          'communication_score',
    label:        'Communication',
    description:  'Ability to express ideas clearly in written and verbal form.',
    engine_weight: { engineering: 0.10, medical: 0.10, commerce: 0.20, humanities: 0.30 },
  },
  {
    key:          'creativity_score',
    label:        'Creativity',
    description:  'Ability to generate novel ideas and think divergently.',
    engine_weight: { engineering: 0.15, medical: 0.15, commerce: 0.15, humanities: 0.20 },
  },
];

module.exports = {
  SUBJECTS,
  STREAMS,
  STREAM_SUBJECT_MAP,
  COGNITIVE_DIMENSIONS,
};









