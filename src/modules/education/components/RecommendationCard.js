/**
 * src/modules/education/components/RecommendationCard.js
 *
 * Production-hardened recommendation hero card.
 *
 * Improvements:
 * - React memoization
 * - frozen stream config
 * - confidence normalization
 * - safer SVG ring calculations
 * - null-safe stream labels
 * - extracted helpers
 * - stable alternative rendering
 */

import { memo, useMemo } from 'react';

// ───────────────────────────────────────────────────────────────────────────────
// Static config
// ───────────────────────────────────────────────────────────────────────────────

const STREAM_CONFIG = Object.freeze({
  engineering: {
    icon: '💻',
    color: '#06b6d4',
    bg: 'rgba(6,182,212,0.08)',
  },
  medical: {
    icon: '🔬',
    color: '#22c55e',
    bg: 'rgba(34,197,94,0.08)',
  },
  commerce: {
    icon: '📊',
    color: '#f59e0b',
    bg: 'rgba(245,158,11,0.08)',
  },
  humanities: {
    icon: '📚',
    color: '#a78bfa',
    bg: 'rgba(167,139,250,0.08)',
  },
});

const DEFAULT_CONFIG = Object.freeze({
  icon: '🎓',
  color: '#06b6d4',
  bg: 'rgba(6,182,212,0.08)',
});

// ───────────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────────

function clampConfidence(value) {
  const num = Number(value);
  if (Number.isNaN(num)) return 0;
  return Math.max(0, Math.min(100, num));
}

function getStreamConfig(stream) {
  return STREAM_CONFIG[stream] || DEFAULT_CONFIG;
}

// ───────────────────────────────────────────────────────────────────────────────
// Main component
// ───────────────────────────────────────────────────────────────────────────────

function RecommendationCardComponent({
  recommended_stream,
  recommended_label,
  confidence,
  alternative_stream,
  alternative_label,
  rationale,
}) {
  const pct = clampConfidence(confidence);

  const cfg = useMemo(
    () => getStreamConfig(recommended_stream),
    [recommended_stream]
  );

  const altCfg = useMemo(
    () => getStreamConfig(alternative_stream),
    [alternative_stream]
  );

  const ring = useMemo(() => {
    const radius = 36;
    const circumference = 2 * Math.PI * radius;
    const dash = (pct / 100) * circumference;

    return {
      radius,
      circumference,
      dash,
    };
  }, [pct]);

  const streamKey = recommended_stream
    ? String(recommended_stream).toUpperCase()
    : 'GENERAL';

  const streamLabel =
    recommended_label ||
    recommended_stream ||
    'Recommended Path';

  const alternativeText =
    alternative_label ||
    alternative_stream ||
    null;

  return (
    <div
      style={{
        ...RC.card,
        borderColor: `${cfg.color}30`,
      }}
    >
      <div style={RC.topRow}>
        <div
          style={{
            ...RC.iconBadge,
            background: cfg.bg,
          }}
        >
          <span style={RC.icon}>{cfg.icon}</span>
        </div>

        <div style={RC.labelGroup}>
          <p style={RC.eyebrow}>Recommended Stream</p>

          <h2
            style={{
              ...RC.streamLabel,
              color: cfg.color,
            }}
          >
            {streamLabel}
          </h2>

          <p style={RC.streamKey}>{streamKey}</p>
        </div>

        <div style={RC.ringWrap}>
          <svg
            width={88}
            height={88}
            style={RC.ringSvg}
            role="img"
            aria-label={`Confidence score ${pct}%`}
          >
            <circle
              cx={44}
              cy={44}
              r={ring.radius}
              fill="none"
              stroke="#1f2937"
              strokeWidth={6}
            />

            <circle
              cx={44}
              cy={44}
              r={ring.radius}
              fill="none"
              stroke={cfg.color}
              strokeWidth={6}
              strokeLinecap="round"
              strokeDasharray={`${ring.dash} ${ring.circumference}`}
              style={{
                filter: `drop-shadow(0 0 4px ${cfg.color}60)`,
              }}
            />
          </svg>

          <div style={RC.ringLabel}>
            <span
              style={{
                ...RC.ringPct,
                color: cfg.color,
              }}
            >
              {pct}
            </span>
            <span style={RC.ringUnit}>%</span>
          </div>

          <p style={RC.ringText}>Confidence</p>
        </div>
      </div>

      {rationale ? (
        <p style={RC.rationale}>{rationale}</p>
      ) : null}

      {alternativeText ? (
        <div style={RC.altRow}>
          <span style={RC.altLabel}>Alternative:</span>

          <span
            style={{
              ...RC.altPill,
              borderColor: `${altCfg.color}40`,
              color: altCfg.color,
              background: altCfg.bg,
            }}
          >
            {altCfg.icon} {alternativeText}
          </span>
        </div>
      ) : null}
    </div>
  );
}

export default memo(RecommendationCardComponent);

// ───────────────────────────────────────────────────────────────────────────────
// Styles
// ───────────────────────────────────────────────────────────────────────────────

const RC = {
  card: {
    background: '#111827',
    border: '1.5px solid #1f2937',
    borderRadius: 20,
    padding: '28px',
    marginBottom: 20,
  },

  topRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 20,
    marginBottom: 20,
  },

  iconBadge: {
    width: 60,
    height: 60,
    borderRadius: 16,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },

  icon: {
    fontSize: 28,
  },

  labelGroup: {
    flex: 1,
  },

  eyebrow: {
    fontSize: 11,
    color: '#6b7280',
    fontWeight: 600,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    margin: '0 0 4px',
  },

  streamLabel: {
    fontFamily: 'Syne, sans-serif',
    fontSize: 26,
    fontWeight: 800,
    margin: '0 0 2px',
    lineHeight: 1.1,
  },

  streamKey: {
    fontSize: 11,
    color: '#4b5563',
    fontWeight: 600,
    letterSpacing: '0.1em',
    margin: 0,
  },

  ringWrap: {
    position: 'relative',
    flexShrink: 0,
    textAlign: 'center',
  },

  ringSvg: {
    transform: 'rotate(-90deg)',
  },

  ringLabel: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
    paddingBottom: 10,
  },

  ringPct: {
    fontFamily: 'Syne, sans-serif',
    fontSize: 20,
    fontWeight: 800,
    lineHeight: 1,
  },

  ringUnit: {
    fontSize: 11,
    color: '#9ca3af',
    alignSelf: 'flex-end',
    paddingBottom: 2,
  },

  ringText: {
    fontSize: 10,
    color: '#6b7280',
    margin: '-4px 0 0',
    fontWeight: 600,
  },

  rationale: {
    fontSize: 13,
    color: '#9ca3af',
    lineHeight: 1.7,
    margin: '0 0 16px',
    padding: '14px 16px',
    background: '#0d1117',
    borderRadius: 10,
    border: '1px solid #1f2937',
  },

  altRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },

  altLabel: {
    fontSize: 12,
    color: '#6b7280',
    fontWeight: 600,
  },

  altPill: {
    fontSize: 12,
    fontWeight: 600,
    padding: '4px 12px',
    borderRadius: 20,
    border: '1.5px solid',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
  },
};