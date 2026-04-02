/**
 * src/modules/education/components/StreamChart.js
 *
 * Production-hardened horizontal stream suitability chart.
 *
 * Improvements:
 * - React memoization
 * - safe score normalization
 * - stable sorting
 * - safe animation lifecycle
 * - removed dead maxScore logic
 * - accessibility improvements
 * - frozen stream config
 */

import { memo, useEffect, useMemo, useState } from 'react';
import { GLOBAL_STYLES } from '../pages/EducationOnboarding';

// ───────────────────────────────────────────────────────────────────────────────
// Static config
// ───────────────────────────────────────────────────────────────────────────────

const STREAM_CONFIG = Object.freeze([
  {
    key: 'engineering',
    label: 'Computer Science',
    icon: '💻',
    color: '#06b6d4',
  },
  {
    key: 'commerce',
    label: 'Commerce',
    icon: '📊',
    color: '#f59e0b',
  },
  {
    key: 'humanities',
    label: 'Humanities',
    icon: '📚',
    color: '#a78bfa',
  },
  {
    key: 'medical',
    label: 'Bio-Maths',
    icon: '🔬',
    color: '#22c55e',
  },
]);

// ───────────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────────

function clampScore(value) {
  const num = Number(value);
  if (Number.isNaN(num)) return 0;
  return Math.max(0, Math.min(100, num));
}

// ───────────────────────────────────────────────────────────────────────────────
// Subcomponent
// ───────────────────────────────────────────────────────────────────────────────

const ScoreBar = memo(function ScoreBar({
  label,
  icon,
  score,
  color,
  isTop,
  animated,
}) {
  const pct = clampScore(score);

  return (
    <div style={SC.barRow}>
      <div style={SC.barLabelGroup}>
        <span style={SC.barIcon}>{icon}</span>

        <span
          style={{
            ...SC.barLabel,
            color: isTop ? '#f9fafb' : '#9ca3af',
          }}
        >
          {label}
        </span>

        {isTop && <span style={SC.topPill}>TOP</span>}
      </div>

      <div style={SC.trackWrap}>
        <div
          style={SC.track}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label={`${label} suitability`}
        >
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

        <span
          style={{
            ...SC.scoreText,
            color: isTop ? color : '#6b7280',
          }}
        >
          {pct}
        </span>
      </div>
    </div>
  );
});

// ───────────────────────────────────────────────────────────────────────────────
// Main component
// ───────────────────────────────────────────────────────────────────────────────

function StreamChartComponent({
  stream_scores = {},
  recommended_stream,
}) {
  const [animated, setAnimated] = useState(false);

  useEffect(() => {
    let isMounted = true;

    const timer = window.setTimeout(() => {
      if (isMounted) setAnimated(true);
    }, 80);

    return () => {
      isMounted = false;
      window.clearTimeout(timer);
    };
  }, []);

  const safeScores = useMemo(() => {
    const scores = stream_scores || {};

    return {
      engineering: clampScore(scores.engineering),
      commerce: clampScore(scores.commerce),
      humanities: clampScore(scores.humanities),
      medical: clampScore(scores.medical),
    };
  }, [stream_scores]);

  const sorted = useMemo(() => {
    return [...STREAM_CONFIG].sort(
      (a, b) => safeScores[b.key] - safeScores[a.key]
    );
  }, [safeScores]);

  return (
    <>
      <div style={SC.card}>
        <p style={SC.heading}>Stream Suitability Analysis</p>
        <p style={SC.sub}>
          How well your profile matches each academic stream
        </p>

        <div style={SC.barList}>
          {sorted.map(({ key, label, icon, color }) => (
            <ScoreBar
              key={key}
              label={label}
              icon={icon}
              score={safeScores[key]}
              color={color}
              isTop={key === recommended_stream}
              animated={animated}
            />
          ))}
        </div>

        <div style={SC.legend}>
          <span style={SC.legendItem}>0 — No match</span>
          <span style={SC.legendItem}>50 — Moderate</span>
          <span style={SC.legendItem}>100 — Perfect fit</span>
        </div>
      </div>

      <style>{GLOBAL_STYLES}</style>
    </>
  );
}

export default memo(StreamChartComponent);

// ───────────────────────────────────────────────────────────────────────────────
// Styles
// ───────────────────────────────────────────────────────────────────────────────

const SC = Object.freeze({
  card: {
    background: '#111827',
    border: '1.5px solid #1f2937',
    borderRadius: 20,
    padding: '28px 28px 20px',
  },

  heading: {
    fontFamily: 'Syne, sans-serif',
    fontSize: 17,
    fontWeight: 700,
    color: '#f9fafb',
    margin: '0 0 4px',
  },

  sub: {
    fontSize: 13,
    color: '#6b7280',
    margin: '0 0 24px',
  },

  barList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 18,
  },

  barRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: 7,
  },

  barLabelGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },

  barIcon: {
    fontSize: 15,
  },

  barLabel: {
    fontSize: 13,
    fontWeight: 600,
    flex: 1,
  },

  topPill: {
    fontSize: 9,
    fontWeight: 800,
    color: '#06b6d4',
    background: 'rgba(6,182,212,0.1)',
    border: '1px solid rgba(6,182,212,0.25)',
    borderRadius: 10,
    padding: '2px 7px',
    letterSpacing: '0.08em',
  },

  trackWrap: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },

  track: {
    flex: 1,
    height: 10,
    background: '#1f2937',
    borderRadius: 6,
    overflow: 'hidden',
  },

  fill: {
    height: '100%',
    borderRadius: 6,
    transition: 'width 0.9s cubic-bezier(0.34,1.2,0.64,1)',
  },

  scoreText: {
    fontSize: 13,
    fontWeight: 700,
    minWidth: 28,
    textAlign: 'right',
  },

  legend: {
    display: 'flex',
    justifyContent: 'space-between',
    marginTop: 20,
    paddingTop: 14,
    borderTop: '1px solid #1f2937',
  },

  legendItem: {
    fontSize: 10,
    color: '#374151',
  },
});