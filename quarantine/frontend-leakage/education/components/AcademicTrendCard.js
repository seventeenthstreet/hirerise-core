/**
 * src/modules/education/components/AcademicTrendCard.js
 *
 * Production-hardened academic trend visualization card.
 *
 * Improvements:
 * - React memoization for render performance
 * - Null-safe subject trend normalization
 * - Stable sorting without mutating derived arrays
 * - Safer numeric guards for marks and velocity
 * - Reduced repeated computations with useMemo
 * - Frozen static config objects
 * - Improved readability and maintainability
 */

import { memo, useMemo } from 'react';
import { GLOBAL_STYLES } from '../pages/EducationOnboarding';

// ───────────────────────────────────────────────────────────────────────────────
// Static Config
// ───────────────────────────────────────────────────────────────────────────────

const TREND_CONFIG = Object.freeze({
  improving: {
    icon: '📈',
    label: 'Improving',
    color: '#22c55e',
    bg: 'rgba(34,197,94,0.08)',
    border: 'rgba(34,197,94,0.2)',
  },
  stable: {
    icon: '➖',
    label: 'Stable',
    color: '#f59e0b',
    bg: 'rgba(245,158,11,0.08)',
    border: 'rgba(245,158,11,0.2)',
  },
  declining: {
    icon: '📉',
    label: 'Declining',
    color: '#ef4444',
    bg: 'rgba(239,68,68,0.08)',
    border: 'rgba(239,68,68,0.2)',
  },
  unknown: {
    icon: '—',
    label: 'No data',
    color: '#4b5563',
    bg: 'rgba(75,85,99,0.08)',
    border: 'rgba(75,85,99,0.2)',
  },
});

const SUBJECT_ICON = Object.freeze({
  Mathematics: '🔢',
  English: '✍️',
  Physics: '⚡',
  Chemistry: '🧪',
  Biology: '🧬',
  'Computer Science': '💻',
  Accountancy: '📒',
  Economics: '📉',
  'Business Studies': '🏢',
  History: '🏛️',
  Geography: '🌍',
  'Political Science': '⚖️',
  Sociology: '👥',
  Psychology: '🧠',
  'Fine Arts': '🎨',
  Statistics: '📊',
  'Second Language': '🗣️',
});

const TREND_ORDER = Object.freeze({
  improving: 0,
  stable: 1,
  declining: 2,
  unknown: 3,
});

// ───────────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────────

function clampMarks(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  return Math.max(0, Math.min(100, value));
}

function getTrendMeta(trend) {
  return TREND_CONFIG[trend] || TREND_CONFIG.unknown;
}

// ───────────────────────────────────────────────────────────────────────────────
// Subcomponents
// ───────────────────────────────────────────────────────────────────────────────

const VelocityBadge = memo(function VelocityBadge({ velocity }) {
  if (typeof velocity !== 'number' || Number.isNaN(velocity)) return null;

  const positive = velocity >= 0;

  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 700,
        color: positive ? '#22c55e' : '#ef4444',
        background: positive
          ? 'rgba(34,197,94,0.1)'
          : 'rgba(239,68,68,0.1)',
        border: `1px solid ${
          positive
            ? 'rgba(34,197,94,0.25)'
            : 'rgba(239,68,68,0.25)'
        }`,
        borderRadius: 10,
        padding: '2px 7px',
      }}
    >
      {positive ? '+' : ''}
      {velocity.toFixed(1)}/yr
    </span>
  );
});

const SubjectRow = memo(function SubjectRow({ subject, data }) {
  const trend = data?.trend || 'unknown';
  const cfg = getTrendMeta(trend);
  const marks = clampMarks(data?.latest_marks);
  const icon = SUBJECT_ICON[subject] || '📖';

  const marksColor =
    marks >= 75 ? '#22c55e' : marks >= 50 ? '#f59e0b' : '#ef4444';

  return (
    <div style={AT.row}>
      <div style={AT.subjectCol}>
        <span style={AT.subjectIcon}>{icon}</span>
        <span style={AT.subjectName}>{subject}</span>
      </div>

      {marks !== null ? (
        <div style={AT.marksCol}>
          <div style={AT.marksTrack}>
            <div
              style={{
                ...AT.marksBar,
                width: `${marks}%`,
                background: marksColor,
              }}
            />
          </div>
          <span style={AT.marksText}>{marks}%</span>
        </div>
      ) : (
        <div />
      )}

      <div style={AT.trendCol}>
        <span
          style={{
            ...AT.trendBadge,
            color: cfg.color,
            background: cfg.bg,
            borderColor: cfg.border,
          }}
        >
          {cfg.icon} {cfg.label}
        </span>

        <VelocityBadge velocity={data?.velocity} />
      </div>
    </div>
  );
});

// ───────────────────────────────────────────────────────────────────────────────
// Main Component
// ───────────────────────────────────────────────────────────────────────────────

function AcademicTrendCardComponent({
  subject_trends = {},
  overall_learning_velocity,
}) {
  const subjects = useMemo(() => {
    return Object.entries(subject_trends || {}).sort(
      ([, a], [, b]) =>
        (TREND_ORDER[a?.trend] ?? 3) - (TREND_ORDER[b?.trend] ?? 3)
    );
  }, [subject_trends]);

  const summary = useMemo(() => {
    let improving = 0;
    let declining = 0;

    for (const [, trendData] of subjects) {
      if (trendData?.trend === 'improving') improving += 1;
      if (trendData?.trend === 'declining') declining += 1;
    }

    return {
      improving,
      declining,
      stable: subjects.length - improving - declining,
    };
  }, [subjects]);

  const velocity =
    typeof overall_learning_velocity === 'number'
      ? overall_learning_velocity
      : null;

  const velColor = velocity !== null && velocity >= 0
    ? '#22c55e'
    : '#ef4444';

  return (
    <>
      <div style={AT.card}>
        <div style={AT.header}>
          <div>
            <p style={AT.heading}>Academic Trends</p>
            <p style={AT.sub}>Subject performance across class levels</p>
          </div>

          {velocity !== null && (
            <div style={AT.velWrap}>
              <span style={AT.velLabel}>Learning velocity</span>
              <span style={{ ...AT.velValue, color: velColor }}>
                {velocity >= 0 ? '+' : ''}
                {velocity}/yr
              </span>
            </div>
          )}
        </div>

        {subjects.length > 0 && (
          <div style={AT.summaryRow}>
            <span
              style={{
                ...AT.sumPill,
                color: '#22c55e',
                background: 'rgba(34,197,94,0.08)',
                borderColor: 'rgba(34,197,94,0.2)',
              }}
            >
              📈 {summary.improving} improving
            </span>

            <span
              style={{
                ...AT.sumPill,
                color: '#f59e0b',
                background: 'rgba(245,158,11,0.08)',
                borderColor: 'rgba(245,158,11,0.2)',
              }}
            >
              ➖ {summary.stable} stable
            </span>

            {summary.declining > 0 && (
              <span
                style={{
                  ...AT.sumPill,
                  color: '#ef4444',
                  background: 'rgba(239,68,68,0.08)',
                  borderColor: 'rgba(239,68,68,0.2)',
                }}
              >
                📉 {summary.declining} declining
              </span>
            )}
          </div>
        )}

        {subjects.length > 0 ? (
          <div style={AT.list}>
            <div style={AT.colHeaders}>
              <span style={AT.colH}>Subject</span>
              <span style={AT.colH}>Latest Score</span>
              <span style={AT.colH}>Trend</span>
            </div>

            {subjects.map(([subject, data]) => (
              <SubjectRow
                key={subject}
                subject={subject}
                data={data}
              />
            ))}
          </div>
        ) : (
          <p style={AT.empty}>
            No academic data available. Complete the marks step to see trends.
          </p>
        )}
      </div>

      <style>{GLOBAL_STYLES}</style>
    </>
  );
}

export default memo(AcademicTrendCardComponent);

// ───────────────────────────────────────────────────────────────────────────────
// Styles
// ───────────────────────────────────────────────────────────────────────────────

const AT = {
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
    marginBottom: 16,
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
    fontSize: 13,
    color: '#6b7280',
    margin: '4px 0 0',
  },
  velWrap: {
    textAlign: 'right',
    flexShrink: 0,
  },
  velLabel: {
    fontSize: 10,
    color: '#6b7280',
    display: 'block',
    marginBottom: 2,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  velValue: {
    fontSize: 18,
    fontWeight: 800,
  },
  summaryRow: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
    marginBottom: 20,
  },
  sumPill: {
    fontSize: 11,
    fontWeight: 600,
    padding: '4px 10px',
    borderRadius: 20,
    border: '1.5px solid',
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
  },
  colHeaders: {
    display: 'grid',
    gridTemplateColumns: '1fr 120px 1fr',
    gap: 10,
    padding: '0 0 8px',
    borderBottom: '1px solid #1f2937',
    marginBottom: 8,
  },
  colH: {
    fontSize: 10,
    fontWeight: 700,
    color: '#4b5563',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  },
  row: {
    display: 'grid',
    gridTemplateColumns: '1fr 120px 1fr',
    gap: 10,
    padding: '10px 0',
    borderBottom: '1px solid #0d1117',
    alignItems: 'center',
  },
  subjectCol: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  subjectIcon: {
    fontSize: 16,
    flexShrink: 0,
  },
  subjectName: {
    fontSize: 13,
    color: '#d1d5db',
    fontWeight: 500,
  },
  marksCol: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  marksTrack: {
    flex: 1,
    height: 5,
    background: '#1f2937',
    borderRadius: 3,
    overflow: 'hidden',
  },
  marksBar: {
    height: '100%',
    borderRadius: 3,
    transition: 'width 0.6s ease',
  },
  marksText: {
    fontSize: 12,
    fontWeight: 700,
    color: '#9ca3af',
    minWidth: 32,
    textAlign: 'right',
  },
  trendCol: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  trendBadge: {
    fontSize: 11,
    fontWeight: 600,
    padding: '3px 9px',
    borderRadius: 12,
    border: '1.5px solid',
  },
  empty: {
    fontSize: 13,
    color: '#4b5563',
    textAlign: 'center',
    padding: '20px 0',
    margin: 0,
  },
};