/**
 * src/modules/education/components/CognitiveRadar.js
 *
 * Pentagon radar chart visualising the five cognitive dimensions.
 * Pure SVG — no external library needed.
 *
 * Props:
 *   scores  — object from _debug.cognitive or cognitive field:
 *             { analytical, logical, memory, communication, creativity }
 *             Values 0–100.
 *   profile_label — string  e.g. "Analytical-Logical"
 *   strengths     — string[]
 */

import { useEffect, useState } from 'react';
import { GLOBAL_STYLES } from '../pages/EducationOnboarding';

const DIMENSIONS = [
  { key: 'analytical',    label: 'Analytical',     color: '#06b6d4' },
  { key: 'logical',       label: 'Logical',         color: '#6366f1' },
  { key: 'memory',        label: 'Memory',          color: '#22c55e' },
  { key: 'communication', label: 'Communication',   color: '#f59e0b' },
  { key: 'creativity',    label: 'Creativity',      color: '#f43f5e' },
];

const SIZE    = 200;   // SVG viewport half-size (full = 400)
const LEVELS  = 4;     // concentric rings
const ACCENT  = '#06b6d4';

// Polar → cartesian for N-sided polygon
function polar(cx, cy, r, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

// Build SVG polygon points string from values array (0–100)
function buildPolygon(values, maxR, cx, cy, n) {
  const step = 360 / n;
  return values
    .map((v, i) => {
      const r = (v / 100) * maxR;
      const p = polar(cx, cy, r, i * step);
      return `${p.x},${p.y}`;
    })
    .join(' ');
}

function ScoreRow({ label, value, color }) {
  const pct = Math.max(0, Math.min(100, value ?? 0));
  const levelLabel =
    pct >= 80 ? 'Excellent' :
    pct >= 60 ? 'Good'      :
    pct >= 40 ? 'Average'   : 'Developing';

  return (
    <div style={CR.scoreRow}>
      <div style={{ width: 10, height: 10, borderRadius: '50%', background: color, flexShrink: 0 }} />
      <span style={CR.scoreLabel}>{label}</span>
      <div style={CR.scoreMini}>
        <div style={CR.scoreMiniTrack}>
          <div style={{ ...CR.scoreMiniBar, width: `${pct}%`, background: color }} />
        </div>
      </div>
      <span style={{ ...CR.scoreVal, color }}>{pct}</span>
      <span style={CR.scoreLevel}>{levelLabel}</span>
    </div>
  );
}

export default function CognitiveRadar({ scores = {}, profile_label, strengths = [] }) {
  const [animated, setAnimated] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setAnimated(true), 100);
    return () => clearTimeout(t);
  }, []);

  const cx = SIZE;
  const cy = SIZE;
  const maxR = SIZE * 0.68;
  const n = DIMENSIONS.length;
  const step = 360 / n;

  // Normalised score values
  const values = DIMENSIONS.map(d => Math.max(0, Math.min(100, scores[d.key] ?? 0)));

  // Background level rings (25, 50, 75, 100)
  const rings = [25, 50, 75, 100].map(pct => {
    const r = (pct / 100) * maxR;
    const pts = DIMENSIONS.map((_, i) => {
      const p = polar(cx, cy, r, i * step);
      return `${p.x},${p.y}`;
    }).join(' ');
    return { pct, pts };
  });

  // Axis lines from centre to each vertex
  const axes = DIMENSIONS.map((_, i) => {
    const end = polar(cx, cy, maxR + 10, i * step);
    return { x1: cx, y1: cy, x2: end.x, y2: end.y };
  });

  // Label positions (further out)
  const labelPositions = DIMENSIONS.map((d, i) => {
    const p = polar(cx, cy, maxR + 30, i * step);
    return { ...p, label: d.label, color: d.color };
  });

  const dataPoints = buildPolygon(animated ? values : values.map(() => 0), maxR, cx, cy, n);

  return (
    <>
      <div style={CR.card}>
        <div style={CR.header}>
          <div>
            <p style={CR.heading}>Cognitive Profile</p>
            {profile_label && <p style={CR.sub}>{profile_label}</p>}
          </div>
          {strengths.length > 0 && (
            <div style={CR.strengthPills}>
              {strengths.slice(0, 2).map(s => (
                <span key={s} style={CR.pill}>{s}</span>
              ))}
            </div>
          )}
        </div>

        {/* ── Radar SVG ── */}
        <div style={CR.svgWrap}>
          <svg
            viewBox={`0 0 ${SIZE * 2} ${SIZE * 2}`}
            style={{ width: '100%', maxWidth: 320, height: 'auto', overflow: 'visible' }}
          >
            {/* Background rings */}
            {rings.map(({ pct, pts }) => (
              <polygon
                key={pct}
                points={pts}
                fill="none"
                stroke="#1f2937"
                strokeWidth={pct === 50 ? 1.5 : 1}
                strokeDasharray={pct === 100 ? 'none' : '3 3'}
              />
            ))}

            {/* Axis lines */}
            {axes.map((a, i) => (
              <line key={i} {...a} stroke="#1f2937" strokeWidth={1} />
            ))}

            {/* Data polygon */}
            <polygon
              points={dataPoints}
              fill={`${ACCENT}18`}
              stroke={ACCENT}
              strokeWidth={2}
              strokeLinejoin="round"
              style={{ transition: 'all 0.8s cubic-bezier(0.34,1.1,0.64,1)' }}
            />

            {/* Data point dots */}
            {DIMENSIONS.map((d, i) => {
              const r = ((animated ? values[i] : 0) / 100) * maxR;
              const p = polar(cx, cy, r, i * step);
              return (
                <circle
                  key={d.key}
                  cx={p.x} cy={p.y} r={5}
                  fill={d.color}
                  stroke="#0d1117"
                  strokeWidth={2}
                  style={{ transition: `all 0.8s cubic-bezier(0.34,1.1,0.64,1) ${i * 0.06}s` }}
                />
              );
            })}

            {/* Axis labels */}
            {labelPositions.map(({ x, y, label, color }) => (
              <text
                key={label}
                x={x} y={y}
                textAnchor="middle"
                dominantBaseline="middle"
                fill={color}
                fontSize={13}
                fontWeight={600}
                fontFamily="DM Sans, sans-serif"
              >
                {label}
              </text>
            ))}
          </svg>
        </div>

        {/* ── Score breakdown list ── */}
        <div style={CR.scoreList}>
          {DIMENSIONS.map((d, i) => (
            <ScoreRow key={d.key} label={d.label} value={values[i]} color={d.color} />
          ))}
        </div>
      </div>
      <style>{GLOBAL_STYLES}</style>
    </>
  );
}

const CR = {
  card:          { background: '#111827', border: '1.5px solid #1f2937', borderRadius: 20, padding: '28px 28px 24px' },
  header:        { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, gap: 12 },
  heading:       { fontFamily: 'Syne, sans-serif', fontSize: 17, fontWeight: 700, color: '#f9fafb', margin: 0 },
  sub:           { fontSize: 12, color: '#06b6d4', margin: '4px 0 0', fontWeight: 600 },
  strengthPills: { display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' },
  pill:          { fontSize: 10, fontWeight: 600, color: '#6366f1', background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 10, padding: '3px 8px' },
  svgWrap:       { display: 'flex', justifyContent: 'center', marginBottom: 24 },
  scoreList:     { display: 'flex', flexDirection: 'column', gap: 10, borderTop: '1px solid #1f2937', paddingTop: 20 },
  scoreRow:      { display: 'grid', gridTemplateColumns: '10px 1fr 80px 28px 72px', alignItems: 'center', gap: 10 },
  scoreLabel:    { fontSize: 13, color: '#d1d5db', fontWeight: 500 },
  scoreMini:     {},
  scoreMiniTrack:{ height: 4, background: '#1f2937', borderRadius: 3, overflow: 'hidden' },
  scoreMiniBar:  { height: '100%', borderRadius: 3, transition: 'width 0.6s ease' },
  scoreVal:      { fontSize: 14, fontWeight: 700, textAlign: 'right' },
  scoreLevel:    { fontSize: 10, color: '#4b5563', textAlign: 'right' },
};








