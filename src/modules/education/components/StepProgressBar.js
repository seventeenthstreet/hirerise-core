/**
 * src/modules/education/components/StepProgressBar.js
 *
 * Reusable step-progress indicator for the Education Onboarding flow.
 *
 * Props:
 *   steps       — string[]   e.g. ['Profile', 'Marks', 'Activities', 'Cognitive', 'Review']
 *   currentStep — number     0-based index of the active step
 */

export default function StepProgressBar({ steps, currentStep }) {
  const pct = steps.length > 1
    ? Math.round((currentStep / (steps.length - 1)) * 100)
    : 0;

  return (
    <div style={S.wrap}>
      {/* ── Numeric label ── */}
      <div style={S.labelRow}>
        <span style={S.counter}>
          Step {currentStep + 1} of {steps.length}
        </span>
        <span style={S.pctLabel}>{pct}% complete</span>
      </div>

      {/* ── Continuous bar ── */}
      <div style={S.track}>
        <div style={{ ...S.fill, width: `${pct}%` }} />
      </div>

      {/* ── Step dots + labels ── */}
      <div style={S.dotsRow}>
        {steps.map((label, i) => {
          const done   = i < currentStep;
          const active = i === currentStep;
          return (
            <div key={label} style={S.dotGroup}>
              <div style={{
                ...S.dot,
                ...(active ? S.dotActive : {}),
                ...(done   ? S.dotDone   : {}),
              }}>
                {done ? '✓' : i + 1}
              </div>
              <span style={{
                ...S.dotLabel,
                ...(active ? S.dotLabelActive : {}),
                ...(done   ? S.dotLabelDone   : {}),
              }}>
                {label}
              </span>
            </div>
          );
        })}
      </div>

      <style>{STYLES}</style>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const S = {
  wrap:          { padding: '14px 24px 0' },
  labelRow:      { display: 'flex', justifyContent: 'space-between', alignItems: 'center', maxWidth: 820, margin: '0 auto', paddingBottom: 10 },
  counter:       { fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: 14, color: '#f9fafb' },
  pctLabel:      { fontSize: 12, color: '#6b7280' },
  track:         { height: 3, background: '#1f2937', borderRadius: 2 },
  fill:          { height: '100%', background: 'linear-gradient(90deg, #06b6d4, #6366f1)', borderRadius: 2, transition: 'width 0.45s ease' },
  dotsRow:       { display: 'flex', justifyContent: 'center', gap: 0, padding: '12px 0', maxWidth: 820, margin: '0 auto' },
  dotGroup:      { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, flex: 1 },
  dot:           { width: 26, height: 26, borderRadius: '50%', border: '2px solid #374151', background: 'transparent', color: '#6b7280', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, transition: 'all 0.2s' },
  dotActive:     { borderColor: '#06b6d4', color: '#06b6d4', background: 'rgba(6,182,212,0.12)' },
  dotDone:       { borderColor: '#22c55e', background: '#22c55e', color: '#000', border: 'none' },
  dotLabel:      { fontSize: 10, color: '#4b5563', whiteSpace: 'nowrap', textAlign: 'center' },
  dotLabelActive:{ color: '#06b6d4' },
  dotLabelDone:  { color: '#22c55e' },
};

const STYLES = `
  @media (max-width: 520px) {
    /* hide labels on very small screens, keep dots */
    .edu-step-label { display: none; }
  }
`;








