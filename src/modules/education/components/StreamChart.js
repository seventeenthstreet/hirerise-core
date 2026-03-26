/**
 * src/modules/education/components/StreamChart.js
 *
 * Horizontal bar chart comparing suitability scores across all four streams.
 * Pure CSS — no external chart library required.
 *
 * Props:
 *   stream_scores        — { engineering, medical, commerce, humanities }
 *   recommended_stream   — string  (highlighted with accent color)
 */

import { useEffect, useState } from 'react';
import { GLOBAL_STYLES } from '../pages/EducationOnboarding';

const STREAM_CONFIG = [
  { key: 'engineering', label: 'Computer Science', icon: '💻', color: '#06b6d4' },
  { key: 'commerce',    label: 'Commerce',         icon: '📊', color: '#f59e0b' },
  { key: 'humanities',  label: 'Humanities',       icon: '📚', color: '#a78bfa' },
  { key: 'medical',     label: 'Bio-Maths',        icon: '🔬', color: '#22c55e' },
];

function ScoreBar({ label, icon, score, color, isTop, animated }) {
  const pct = Math.max(0, Math.min(100, score ?? 0));

  return (
    <div style={SC.barRow}>
      {/* Label */}
      <div style={SC.barLabelGroup}>
        <span style={SC.barIcon}>{icon}</span>
        <span style={{ ...SC.barLabel, color: isTop ? '#f9fafb' : '#9ca3af' }}>
          {label}
        </span>
        {isTop && <span style={SC.topPill}>TOP</span>}
      </div>

      {/* Bar track */}
      <div style={SC.trackWrap}>
        <div style={SC.track}>
          <div
            style={{
              ...SC.fill,
              width: animated ? `${pct}%` : '0%',
              background: isTop
                ? `linear-gradient(90deg, ${color}, ${color}cc)`
                : `linear-gradient(90deg, ${color}80, ${color}50)`,
              boxShadow: isTop ? `0 0 12px ${color}40` : 'none',
            }}
          />
        </div>
        <span style={{ ...SC.scoreText, color: isTop ? color : '#6b7280' }}>
          {pct}
        </span>
      </div>
    </div>
  );
}

export default function StreamChart({ stream_scores = {}, recommended_stream }) {
  const [animated, setAnimated] = useState(false);

  // Trigger bar animation after mount
  useEffect(() => {
    const t = setTimeout(() => setAnimated(true), 80);
    return () => clearTimeout(t);
  }, []);

  // Sort by score descending for display
  const sorted = [...STREAM_CONFIG].sort(
    (a, b) => (stream_scores[b.key] ?? 0) - (stream_scores[a.key] ?? 0)
  );

  const maxScore = Math.max(...Object.values(stream_scores).map(Number).filter(Boolean), 1);

  return (
    <>
      <div style={SC.card}>
        <p style={SC.heading}>Stream Suitability Analysis</p>
        <p style={SC.sub}>How well your profile matches each academic stream</p>

        <div style={SC.barList}>
          {sorted.map(({ key, label, icon, color }) => (
            <ScoreBar
              key={key}
              label={label}
              icon={icon}
              score={stream_scores[key] ?? 0}
              color={color}
              isTop={key === recommended_stream}
              animated={animated}
            />
          ))}
        </div>

        {/* Score scale legend */}
        <div style={SC.legend}>
          <span style={SC.legendItem}>0 — No match</span>
          <span style={SC.legendItem}>50 — Moderate</span>
          <span style={SC.legendItem}>100 — Perfect fit</span>
        </div>
      </div>
      <style>{GLOBAL_STYLES}</style>
      <style>{`
        .stream-fill { transition: width 0.9s cubic-bezier(0.34, 1.2, 0.64, 1); }
      `}</style>
    </>
  );
}

const SC = {
  card:          { background: '#111827', border: '1.5px solid #1f2937', borderRadius: 20, padding: '28px 28px 20px' },
  heading:       { fontFamily: 'Syne, sans-serif', fontSize: 17, fontWeight: 700, color: '#f9fafb', margin: '0 0 4px' },
  sub:           { fontSize: 13, color: '#6b7280', margin: '0 0 24px' },
  barList:       { display: 'flex', flexDirection: 'column', gap: 18 },
  barRow:        { display: 'flex', flexDirection: 'column', gap: 7 },
  barLabelGroup: { display: 'flex', alignItems: 'center', gap: 8 },
  barIcon:       { fontSize: 15 },
  barLabel:      { fontSize: 13, fontWeight: 600, flex: 1 },
  topPill:       { fontSize: 9, fontWeight: 800, color: '#06b6d4', background: 'rgba(6,182,212,0.1)', border: '1px solid rgba(6,182,212,0.25)', borderRadius: 10, padding: '2px 7px', letterSpacing: '0.08em' },
  trackWrap:     { display: 'flex', alignItems: 'center', gap: 10 },
  track:         { flex: 1, height: 10, background: '#1f2937', borderRadius: 6, overflow: 'hidden' },
  fill:          { height: '100%', borderRadius: 6, transition: 'width 0.9s cubic-bezier(0.34,1.2,0.64,1)' },
  scoreText:     { fontSize: 13, fontWeight: 700, minWidth: 28, textAlign: 'right' },
  legend:        { display: 'flex', justifyContent: 'space-between', marginTop: 20, paddingTop: 14, borderTop: '1px solid #1f2937' },
  legendItem:    { fontSize: 10, color: '#374151' },
};








