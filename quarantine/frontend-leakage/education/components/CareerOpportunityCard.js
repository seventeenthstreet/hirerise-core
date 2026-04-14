/**
 * src/modules/education/components/CareerOpportunityCard.js
 *
 * Production-hardened career opportunity visualization card.
 *
 * Improvements:
 * - React memoization
 * - stable animation lifecycle
 * - null-safe career normalization
 * - probability sanitization
 * - frozen color palette
 * - useMemo derived rows
 * - safer key generation fallback
 * - helper extraction for readability
 */

import { memo, useEffect, useMemo, useState } from 'react';

// ───────────────────────────────────────────────────────────────────────────────
// Static config
// ───────────────────────────────────────────────────────────────────────────────

const BAR_COLORS = Object.freeze([
  '#06b6d4',
  '#6366f1',
  '#f59e0b',
  '#22c55e',
  '#a78bfa',
]);

function clampProbability(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

// Best-effort emoji icon resolver
function getCareerIcon(career = '') {
  const c = String(career).toLowerCase();

  if (c.includes('software') || c.includes('engineer')) return '💻';
  if (c.includes('ai') || c.includes('ml') || c.includes('machine')) return '🤖';
  if (c.includes('data') || c.includes('analyst')) return '📊';
  if (c.includes('cyber') || c.includes('security')) return '🔒';
  if (c.includes('doctor') || c.includes('mbbs') || c.includes('medical')) return '🩺';
  if (c.includes('biomedical') || c.includes('research')) return '🔬';
  if (c.includes('pharmacist')) return '💊';
  if (c.includes('lawyer') || c.includes('law')) return '⚖️';
  if (c.includes('journalist') || c.includes('writer')) return '✍️';
  if (c.includes('chartered') || c.includes('accountant')) return '📋';
  if (c.includes('banker') || c.includes('investment')) return '🏦';
  if (c.includes('entrepreneur')) return '🚀';
  if (c.includes('marketing')) return '📣';
  if (c.includes('ux') || c.includes('designer')) return '🎨';
  if (c.includes('civil') || c.includes('ias') || c.includes('ips')) return '🏛️';
  if (c.includes('architect') || c.includes('systems')) return '🏗️';

  return '🎯';
}

// ───────────────────────────────────────────────────────────────────────────────
// Subcomponent
// ───────────────────────────────────────────────────────────────────────────────

const CareerBar = memo(function CareerBar({
  career,
  probability,
  color,
  rank,
  animated,
}) {
  const pct = clampProbability(probability);
  const isTop = rank === 0;

  return (
    <div style={CC.barRow}>
      <div style={CC.labelRow}>
        <span style={CC.icon}>{getCareerIcon(career)}</span>

        <span
          style={{
            ...CC.careerName,
            color: isTop ? '#f9fafb' : '#d1d5db',
          }}
        >
          {career}
        </span>

        {isTop && <span style={CC.topPill}>BEST FIT</span>}

        <span style={{ ...CC.pctLabel, color }}>
          {pct}%
        </span>
      </div>

      <div style={CC.track}>
        <div
          style={{
            ...CC.fill,
            width: animated ? `${pct}%` : '0%',
            background: isTop
              ? `linear-gradient(90deg, ${color}, ${color}cc)`
              : `linear-gradient(90deg, ${color}80, ${color}40)`,
            boxShadow: isTop ? `0 0 10px ${color}30` : 'none',
          }}
        />
      </div>
    </div>
  );
});

// ───────────────────────────────────────────────────────────────────────────────
// Main component
// ───────────────────────────────────────────────────────────────────────────────

function CareerOpportunityCardComponent({ top_careers = [] }) {
  const [animated, setAnimated] = useState(false);

  useEffect(() => {
    let isMounted = true;

    const timer = window.setTimeout(() => {
      if (isMounted) setAnimated(true);
    }, 120);

    return () => {
      isMounted = false;
      window.clearTimeout(timer);
    };
  }, []);

  const safeCareers = useMemo(() => {
    if (!Array.isArray(top_careers)) return [];

    return top_careers
      .filter((item) => item && item.career)
      .slice(0, 5)
      .map((item, index) => ({
        career: String(item.career),
        probability: clampProbability(item.probability),
        color: BAR_COLORS[index % BAR_COLORS.length],
        key: `${item.career}-${index}`,
      }));
  }, [top_careers]);

  if (safeCareers.length === 0) {
    return (
      <div style={CC.card}>
        <p style={CC.heading}>
          Career Opportunities Based on Your Profile
        </p>
        <p style={{ ...CC.sub, marginBottom: 0 }}>
          No career predictions available. Run the analysis to generate results.
        </p>
      </div>
    );
  }

  return (
    <div style={CC.card}>
      <div style={CC.headerRow}>
        <span style={CC.headerIcon}>🎯</span>

        <div>
          <p style={CC.heading}>
            Career Opportunities Based on Your Profile
          </p>
          <p style={CC.sub}>
            Success probability based on your cognitive strengths and profile
          </p>
        </div>
      </div>

      <div style={CC.barList}>
        {safeCareers.map((item, index) => (
          <CareerBar
            key={item.key}
            career={item.career}
            probability={item.probability}
            color={item.color}
            rank={index}
            animated={animated}
          />
        ))}
      </div>

      <div style={CC.legendRow}>
        <span style={CC.legendItem}>0% — Low fit</span>
        <span style={CC.legendItem}>50% — Moderate fit</span>
        <span style={CC.legendItem}>100% — Ideal fit</span>
      </div>

      <p style={CC.disclaimer}>
        Probabilities are derived from your cognitive assessment scores.
        Use as guidance alongside broader career research.
      </p>
    </div>
  );
}

export default memo(CareerOpportunityCardComponent);

// ───────────────────────────────────────────────────────────────────────────────
// Styles
// ───────────────────────────────────────────────────────────────────────────────

const CC = {
  card: {
    background: '#111827',
    border: '1.5px solid #1f2937',
    borderRadius: 20,
    padding: '28px 28px 20px',
    marginTop: 20,
  },

  headerRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 12,
    marginBottom: 24,
  },

  headerIcon: {
    fontSize: 28,
    lineHeight: 1,
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
    margin: 0,
  },

  barList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
  },

  barRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },

  labelRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },

  icon: {
    fontSize: 15,
    lineHeight: 1,
    flexShrink: 0,
  },

  careerName: {
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
    flexShrink: 0,
  },

  pctLabel: {
    fontSize: 13,
    fontWeight: 700,
    minWidth: 36,
    textAlign: 'right',
    flexShrink: 0,
  },

  track: {
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

  legendRow: {
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

  disclaimer: {
    fontSize: 11,
    color: '#374151',
    marginTop: 12,
    lineHeight: 1.6,
    textAlign: 'center',
  },
};