/**
 * src/modules/education/components/CognitiveRadar.js
 *
 * Production-hardened SVG pentagon radar chart.
 *
 * Improvements:
 * - React memoization
 * - SVG geometry memoization
 * - safe animation lifecycle
 * - score normalization helpers
 * - frozen dimension config
 * - extracted SVG builders
 * - stronger null safety
 */

import { memo, useEffect, useMemo, useState } from 'react';
import { GLOBAL_STYLES } from '../pages/EducationOnboarding';

// ───────────────────────────────────────────────────────────────────────────────
// Static config
// ───────────────────────────────────────────────────────────────────────────────

const DIMENSIONS = Object.freeze([
  { key: 'analytical', label: 'Analytical', color: '#06b6d4' },
  { key: 'logical', label: 'Logical', color: '#6366f1' },
  { key: 'memory', label: 'Memory', color: '#22c55e' },
  { key: 'communication', label: 'Communication', color: '#f59e0b' },
  { key: 'creativity', label: 'Creativity', color: '#f43f5e' },
]);

const SIZE = 200;
const ACCENT = '#06b6d4';
const RING_LEVELS = Object.freeze([25, 50, 75, 100]);

// ───────────────────────────────────────────────────────────────────────────────
// Geometry helpers
// ───────────────────────────────────────────────────────────────────────────────

function clampScore(value) {
  const num = Number(value);
  if (Number.isNaN(num)) return 0;
  return Math.max(0, Math.min(100, num));
}

function polar(cx, cy, radius, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;

  return {
    x: cx + radius * Math.cos(rad),
    y: cy + radius * Math.sin(rad),
  };
}

function buildPolygon(values, maxR, cx, cy, step) {
  return values
    .map((value, index) => {
      const r = (clampScore(value) / 100) * maxR;
      const point = polar(cx, cy, r, index * step);
      return `${point.x},${point.y}`;
    })
    .join(' ');
}

function getLevelLabel(score) {
  const pct = clampScore(score);

  if (pct >= 80) return 'Excellent';
  if (pct >= 60) return 'Good';
  if (pct >= 40) return 'Average';
  return 'Developing';
}

// ───────────────────────────────────────────────────────────────────────────────
// Subcomponent
// ───────────────────────────────────────────────────────────────────────────────

const ScoreRow = memo(function ScoreRow({
  label,
  value,
  color,
}) {
  const pct = clampScore(value);

  return (
    <div style={CR.scoreRow}>
      <div
        style={{
          ...CR.scoreDot,
          background: color,
        }}
      />

      <span style={CR.scoreLabel}>{label}</span>

      <div style={CR.scoreMini}>
        <div style={CR.scoreMiniTrack}>
          <div
            style={{
              ...CR.scoreMiniBar,
              width: `${pct}%`,
              background: color,
            }}
          />
        </div>
      </div>

      <span style={{ ...CR.scoreVal, color }}>
        {pct}
      </span>

      <span style={CR.scoreLevel}>
        {getLevelLabel(pct)}
      </span>
    </div>
  );
});

// ───────────────────────────────────────────────────────────────────────────────
// Main component
// ───────────────────────────────────────────────────────────────────────────────

function CognitiveRadarComponent({
  scores = {},
  profile_label,
  strengths = [],
}) {
  const [animated, setAnimated] = useState(false);

  useEffect(() => {
    let isMounted = true;

    const timer = window.setTimeout(() => {
      if (isMounted) setAnimated(true);
    }, 100);

    return () => {
      isMounted = false;
      window.clearTimeout(timer);
    };
  }, []);

  const cx = SIZE;
  const cy = SIZE;
  const maxR = SIZE * 0.68;
  const n = DIMENSIONS.length;
  const step = 360 / n;

  const values = useMemo(
    () => DIMENSIONS.map((d) => clampScore(scores?.[d.key])),
    [scores]
  );

  const rings = useMemo(() => {
    return RING_LEVELS.map((pct) => {
      const r = (pct / 100) * maxR;

      const pts = DIMENSIONS.map((_, i) => {
        const point = polar(cx, cy, r, i * step);
        return `${point.x},${point.y}`;
      }).join(' ');

      return { pct, pts };
    });
  }, [cx, cy, maxR, step]);

  const axes = useMemo(() => {
    return DIMENSIONS.map((_, i) => {
      const end = polar(cx, cy, maxR + 10, i * step);

      return {
        x1: cx,
        y1: cy,
        x2: end.x,
        y2: end.y,
      };
    });
  }, [cx, cy, maxR, step]);

  const labelPositions = useMemo(() => {
    return DIMENSIONS.map((dimension, i) => {
      const point = polar(cx, cy, maxR + 30, i * step);

      return {
        ...point,
        label: dimension.label,
        color: dimension.color,
      };
    });
  }, [cx, cy, maxR, step]);

  const polygonPoints = useMemo(() => {
    const animatedValues = animated
      ? values
      : values.map(() => 0);

    return buildPolygon(animatedValues, maxR, cx, cy, step);
  }, [animated, values, maxR, cx, cy, step]);

  const safeStrengths = Array.isArray(strengths)
    ? strengths.slice(0, 2)
    : [];

  return (
    <>
      <div style={CR.card}>
        <div style={CR.header}>
          <div>
            <p style={CR.heading}>Cognitive Profile</p>
            {profile_label && <p style={CR.sub}>{profile_label}</p>}
          </div>

          {safeStrengths.length > 0 && (
            <div style={CR.strengthPills}>
              {safeStrengths.map((strength) => (
                <span key={strength} style={CR.pill}>
                  {strength}
                </span>
              ))}
            </div>
          )}
        </div>

        <div style={CR.svgWrap}>
          <svg
            viewBox={`0 0 ${SIZE * 2} ${SIZE * 2}`}
            style={CR.svg}
            role="img"
            aria-label="Cognitive radar chart"
          >
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

            {axes.map((axis, index) => (
              <line
                key={index}
                {...axis}
                stroke="#1f2937"
                strokeWidth={1}
              />
            ))}

            <polygon
              points={polygonPoints}
              fill={`${ACCENT}18`}
              stroke={ACCENT}
              strokeWidth={2}
              strokeLinejoin="round"
              style={CR.dataPolygon}
            />

            {DIMENSIONS.map((dimension, index) => {
              const radius =
                ((animated ? values[index] : 0) / 100) * maxR;

              const point = polar(cx, cy, radius, index * step);

              return (
                <circle
                  key={dimension.key}
                  cx={point.x}
                  cy={point.y}
                  r={5}
                  fill={dimension.color}
                  stroke="#0d1117"
                  strokeWidth={2}
                  style={{
                    ...CR.dataPoint,
                    transitionDelay: `${index * 0.06}s`,
                  }}
                />
              );
            })}

            {labelPositions.map(({ x, y, label, color }) => (
              <text
                key={label}
                x={x}
                y={y}
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

        <div style={CR.scoreList}>
          {DIMENSIONS.map((dimension, index) => (
            <ScoreRow
              key={dimension.key}
              label={dimension.label}
              value={values[index]}
              color={dimension.color}
            />
          ))}
        </div>
      </div>

      <style>{GLOBAL_STYLES}</style>
    </>
  );
}

export default memo(CognitiveRadarComponent);

// ───────────────────────────────────────────────────────────────────────────────
// Styles
// ───────────────────────────────────────────────────────────────────────────────

const CR = {
  card: {
    background: '#111827',
    border: '1.5px solid #1f2937',
    borderRadius: 20,
    padding: '28px 28px 24px',
  },

  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 20,
    gap: 12,
  },

  heading: {
    fontFamily: 'Syne, sans-serif',
    fontSize: 17,
    fontWeight: 700,
    color: '#f9fafb',
    margin: 0,
  },

  sub: {
    fontSize: 12,
    color: '#06b6d4',
    margin: '4px 0 0',
    fontWeight: 600,
  },

  strengthPills: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
    justifyContent: 'flex-end',
  },

  pill: {
    fontSize: 10,
    fontWeight: 600,
    color: '#6366f1',
    background: 'rgba(99,102,241,0.1)',
    border: '1px solid rgba(99,102,241,0.2)',
    borderRadius: 10,
    padding: '3px 8px',
  },

  svgWrap: {
    display: 'flex',
    justifyContent: 'center',
    marginBottom: 24,
  },

  svg: {
    width: '100%',
    maxWidth: 320,
    height: 'auto',
    overflow: 'visible',
  },

  dataPolygon: {
    transition: 'all 0.8s cubic-bezier(0.34,1.1,0.64,1)',
  },

  dataPoint: {
    transition: 'all 0.8s cubic-bezier(0.34,1.1,0.64,1)',
  },

  scoreList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    borderTop: '1px solid #1f2937',
    paddingTop: 20,
  },

  scoreRow: {
    display: 'grid',
    gridTemplateColumns: '10px 1fr 80px 28px 72px',
    alignItems: 'center',
    gap: 10,
  },

  scoreDot: {
    width: 10,
    height: 10,
    borderRadius: '50%',
    flexShrink: 0,
  },

  scoreLabel: {
    fontSize: 13,
    color: '#d1d5db',
    fontWeight: 500,
  },

  scoreMini: {},

  scoreMiniTrack: {
    height: 4,
    background: '#1f2937',
    borderRadius: 3,
    overflow: 'hidden',
  },

  scoreMiniBar: {
    height: '100%',
    borderRadius: 3,
    transition: 'width 0.6s ease',
  },

  scoreVal: {
    fontSize: 14,
    fontWeight: 700,
    textAlign: 'right',
  },

  scoreLevel: {
    fontSize: 10,
    color: '#4b5563',
    textAlign: 'right',
  },
};