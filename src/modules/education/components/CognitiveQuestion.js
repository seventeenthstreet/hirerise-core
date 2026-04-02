/**
 * src/modules/education/components/CognitiveQuestion.js
 *
 * Production-hardened cognitive assessment question renderer.
 *
 * Improvements:
 * - React memoization
 * - null-safe question normalization
 * - stable option rendering
 * - type-safe slider + sequence handling
 * - extracted reusable sub-renderers
 * - accessibility improvements
 * - frozen label map
 */

import { memo, useCallback, useMemo } from 'react';
import { GLOBAL_STYLES } from '../pages/EducationOnboarding';

// ───────────────────────────────────────────────────────────────────────────────
// Static config
// ───────────────────────────────────────────────────────────────────────────────

const DIMENSION_LABEL = Object.freeze({
  logical: 'Logical Reasoning',
  pattern: 'Pattern Recognition',
  memory: 'Memory Recall',
  communication: 'Communication',
  analytical: 'Analytical Thinking',
  creativity: 'Creativity',
});

// ───────────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────────

function clampScore(value) {
  const num = Number(value);
  if (Number.isNaN(num)) return 50;
  return Math.max(0, Math.min(100, num));
}

function scoreLabel(value) {
  const v = clampScore(value);

  if (v < 25) return 'Needs Work';
  if (v < 50) return 'Average';
  if (v < 75) return 'Good';
  if (v < 90) return 'Strong';
  return 'Excellent';
}

function scoreColor(value) {
  const v = clampScore(value);

  if (v < 25) return '#ef4444';
  if (v < 50) return '#f97316';
  if (v < 75) return '#f59e0b';
  if (v < 90) return '#22c55e';
  return '#06b6d4';
}

// ───────────────────────────────────────────────────────────────────────────────
// Sub-renderers
// ───────────────────────────────────────────────────────────────────────────────

const McqOptions = memo(function McqOptions({
  options,
  answer,
  onSelect,
}) {
  return (
    <div style={S.optionGrid}>
      {options.map((opt) => {
        const selected = answer === opt.value;

        return (
          <button
            key={String(opt.value)}
            type="button"
            onClick={() => onSelect(opt.value)}
            style={selected ? S.optSelected : S.opt}
            aria-pressed={selected}
          >
            <span
              style={selected ? S.optLetterSelected : S.optLetter}
            >
              {opt.value}
            </span>

            <span style={S.optText}>{opt.label}</span>

            {selected && <span style={S.checkMark}>✓</span>}
          </button>
        );
      })}
    </div>
  );
});

const SequenceInput = memo(function SequenceInput({
  answer,
  onChange,
}) {
  return (
    <div style={S.seqWrap}>
      <p style={S.seqHint}>What comes next in the sequence?</p>

      <input
        className="edu-input"
        type="text"
        placeholder="Your answer…"
        value={answer ?? ''}
        onChange={(e) => onChange(e.target.value)}
        style={S.sequenceInput}
      />
    </div>
  );
});

const SliderInput = memo(function SliderInput({
  answer,
  onChange,
}) {
  const value = clampScore(answer);
  const color = scoreColor(value);

  return (
    <div style={S.sliderWrap}>
      <div style={S.sliderHeader}>
        <span style={S.sliderMin}>0 — Very Low</span>

        <span style={{ ...S.sliderScore, color }}>
          {value} — {scoreLabel(value)}
        </span>

        <span style={S.sliderMax}>100 — Excellent</span>
      </div>

      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{
          ...S.sliderInput,
          accentColor: color,
        }}
        aria-label="Self assessment score"
      />
    </div>
  );
});

// ───────────────────────────────────────────────────────────────────────────────
// Main component
// ───────────────────────────────────────────────────────────────────────────────

function CognitiveQuestionComponent({
  question,
  answer,
  onChange,
  index,
  total,
}) {
  const safeQuestion = question || {};

  const {
    id,
    type = 'mcq',
    dimension,
    text = '',
    options = [],
  } = safeQuestion;

  const safeOptions = useMemo(
    () => Array.isArray(options) ? options : [],
    [options]
  );

  const handleSelect = useCallback(
    (value) => {
      if (typeof onChange === 'function' && id != null) {
        onChange(id, value);
      }
    },
    [id, onChange]
  );

  const dimensionLabel =
    DIMENSION_LABEL[dimension] || dimension || 'General';

  return (
    <>
      <div style={S.wrap}>
        <div style={S.header}>
          <span style={S.qNum}>
            Q{index} of {total}
          </span>

          <span style={S.badge}>{dimensionLabel}</span>
        </div>

        <p style={S.qText}>{text}</p>

        {type === 'mcq' && (
          <McqOptions
            options={safeOptions}
            answer={answer}
            onSelect={handleSelect}
          />
        )}

        {type === 'sequence' && (
          <SequenceInput
            answer={answer}
            onChange={handleSelect}
          />
        )}

        {type === 'slider' && (
          <SliderInput
            answer={answer}
            onChange={handleSelect}
          />
        )}
      </div>

      <style>{GLOBAL_STYLES}</style>
    </>
  );
}

export default memo(CognitiveQuestionComponent);

// ───────────────────────────────────────────────────────────────────────────────
// Styles
// ───────────────────────────────────────────────────────────────────────────────

const S = {
  wrap: {
    padding: '20px 0',
  },

  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },

  qNum: {
    fontSize: 12,
    color: '#4b5563',
    fontWeight: 600,
  },

  badge: {
    fontSize: 10,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    color: '#6366f1',
    background: 'rgba(99,102,241,0.1)',
    border: '1px solid rgba(99,102,241,0.2)',
    borderRadius: 20,
    padding: '2px 8px',
  },

  qText: {
    fontSize: 16,
    fontWeight: 600,
    color: '#f3f4f6',
    lineHeight: 1.55,
    margin: '0 0 18px',
  },

  optionGrid: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },

  opt: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '12px 14px',
    background: 'transparent',
    border: '1.5px solid #1f2937',
    borderRadius: 10,
    cursor: 'pointer',
    textAlign: 'left',
    transition: 'all 0.15s',
    width: '100%',
  },

  optSelected: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '12px 14px',
    background: 'rgba(6,182,212,0.08)',
    border: '1.5px solid #06b6d4',
    borderRadius: 10,
    cursor: 'pointer',
    textAlign: 'left',
    transition: 'all 0.15s',
    width: '100%',
  },

  optLetter: {
    width: 24,
    height: 24,
    borderRadius: '50%',
    border: '1.5px solid #374151',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 11,
    fontWeight: 700,
    color: '#6b7280',
    flexShrink: 0,
  },

  optLetterSelected: {
    width: 24,
    height: 24,
    borderRadius: '50%',
    border: '1.5px solid #06b6d4',
    background: '#06b6d4',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 11,
    fontWeight: 700,
    color: '#000',
    flexShrink: 0,
  },

  optText: {
    fontSize: 14,
    color: '#d1d5db',
    flex: 1,
  },

  checkMark: {
    fontSize: 13,
    color: '#06b6d4',
    marginLeft: 'auto',
  },

  seqWrap: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },

  seqHint: {
    fontSize: 12,
    color: '#6b7280',
    margin: 0,
  },

  sequenceInput: {
    maxWidth: 200,
  },

  sliderWrap: {
    paddingTop: 4,
  },

  sliderHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    marginBottom: 6,
  },

  sliderInput: {
    width: '100%',
    cursor: 'pointer',
  },

  sliderMin: {
    fontSize: 10,
    color: '#374151',
  },

  sliderMax: {
    fontSize: 10,
    color: '#374151',
  },

  sliderScore: {
    fontSize: 12,
    fontWeight: 700,
  },
};