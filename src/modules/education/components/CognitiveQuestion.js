/**
 * src/modules/education/components/CognitiveQuestion.js
 *
 * Renders a single aptitude / cognitive test question.
 * Supports three question types:
 *   'mcq'      — multiple choice, single answer
 *   'sequence' — number / pattern sequence with a text input
 *   'slider'   — self-rating 0–100 (used by the self-assessment fallback)
 *
 * Props:
 *   question  — { id, type, dimension, text, options?, correct? }
 *   answer    — current answer value (string | number | null)
 *   onChange  — (questionId, value) => void
 *   index     — display number (1-based)
 *   total     — total question count for "Q n of N" label
 */

import { GLOBAL_STYLES } from '../pages/EducationOnboarding';

export default function CognitiveQuestion({ question, answer, onChange, index, total }) {
  const { id, type, dimension, text, options } = question;

  const handleSelect = (value) => onChange(id, value);

  return (
    <>
      <div style={S.wrap}>
        {/* ── Header ── */}
        <div style={S.header}>
          <span style={S.qNum}>Q{index} of {total}</span>
          <span style={S.badge}>{DIMENSION_LABEL[dimension] || dimension}</span>
        </div>

        {/* ── Question text ── */}
        <p style={S.qText}>{text}</p>

        {/* ── Answer area ── */}
        {type === 'mcq' && (
          <div style={S.optionGrid}>
            {options.map((opt) => {
              const selected = answer === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => handleSelect(opt.value)}
                  style={selected ? S.optSelected : S.opt}
                >
                  <span style={selected ? S.optLetterSelected : S.optLetter}>
                    {opt.value}
                  </span>
                  <span style={S.optText}>{opt.label}</span>
                  {selected && <span style={S.checkMark}>✓</span>}
                </button>
              );
            })}
          </div>
        )}

        {type === 'sequence' && (
          <div style={S.seqWrap}>
            <p style={S.seqHint}>What comes next in the sequence?</p>
            <input
              className="edu-input"
              type="text"
              placeholder="Your answer…"
              value={answer ?? ''}
              onChange={(e) => handleSelect(e.target.value)}
              style={{ maxWidth: 200 }}
            />
          </div>
        )}

        {type === 'slider' && (
          <div style={S.sliderWrap}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={S.sliderMin}>0 — Very Low</span>
              <span style={{ ...S.sliderScore, color: scoreColor(answer ?? 50) }}>
                {answer ?? 50} — {scoreLabel(answer ?? 50)}
              </span>
              <span style={S.sliderMax}>100 — Excellent</span>
            </div>
            <input
              type="range"
              min={0} max={100} step={5}
              value={answer ?? 50}
              onChange={(e) => handleSelect(Number(e.target.value))}
              style={{ width: '100%', accentColor: scoreColor(answer ?? 50), cursor: 'pointer' }}
            />
          </div>
        )}
      </div>
      <style>{GLOBAL_STYLES}</style>
    </>
  );
}

// ─── helpers ─────────────────────────────────────────────────────────────────

const DIMENSION_LABEL = {
  logical:       'Logical Reasoning',
  pattern:       'Pattern Recognition',
  memory:        'Memory Recall',
  communication: 'Communication',
  analytical:    'Analytical Thinking',
  creativity:    'Creativity',
};

function scoreLabel(v) {
  if (v < 25) return 'Needs Work';
  if (v < 50) return 'Average';
  if (v < 75) return 'Good';
  if (v < 90) return 'Strong';
  return 'Excellent';
}

function scoreColor(v) {
  if (v < 25) return '#ef4444';
  if (v < 50) return '#f97316';
  if (v < 75) return '#f59e0b';
  if (v < 90) return '#22c55e';
  return '#06b6d4';
}

// ─── styles ───────────────────────────────────────────────────────────────────

const S = {
  wrap:            { padding: '20px 0' },
  header:          { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  qNum:            { fontSize: 12, color: '#4b5563', fontWeight: 600 },
  badge:           { fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#6366f1', background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 20, padding: '2px 8px' },
  qText:           { fontSize: 16, fontWeight: 600, color: '#f3f4f6', lineHeight: 1.55, margin: '0 0 18px' },
  optionGrid:      { display: 'flex', flexDirection: 'column', gap: 8 },
  opt:             { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', background: 'transparent', border: '1.5px solid #1f2937', borderRadius: 10, cursor: 'pointer', textAlign: 'left', transition: 'all 0.15s', width: '100%' },
  optSelected:     { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', background: 'rgba(6,182,212,0.08)', border: '1.5px solid #06b6d4', borderRadius: 10, cursor: 'pointer', textAlign: 'left', transition: 'all 0.15s', width: '100%' },
  optLetter:       { width: 24, height: 24, borderRadius: '50%', border: '1.5px solid #374151', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: '#6b7280', flexShrink: 0 },
  optLetterSelected:{ width: 24, height: 24, borderRadius: '50%', border: '1.5px solid #06b6d4', background: '#06b6d4', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: '#000', flexShrink: 0 },
  optText:         { fontSize: 14, color: '#d1d5db', flex: 1 },
  checkMark:       { fontSize: 13, color: '#06b6d4', marginLeft: 'auto' },
  seqWrap:         { display: 'flex', flexDirection: 'column', gap: 10 },
  seqHint:         { fontSize: 12, color: '#6b7280', margin: 0 },
  sliderWrap:      { paddingTop: 4 },
  sliderMin:       { fontSize: 10, color: '#374151' },
  sliderMax:       { fontSize: 10, color: '#374151' },
  sliderScore:     { fontSize: 12, fontWeight: 700 },
};








