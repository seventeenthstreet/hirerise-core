/**
 * src/modules/education/components/AcademicTrendCard.js
 *
 * Displays per-subject academic trend insights from the AI engine.
 *
 * Props:
 *   subject_trends  — object from _debug.academic.subject_trends:
 *     { Mathematics: { latest_marks, trend, velocity, strength }, ... }
 *   overall_learning_velocity — number
 */

import { GLOBAL_STYLES } from '../pages/EducationOnboarding';

// ─── Config ───────────────────────────────────────────────────────────────────

const TREND_CONFIG = {
  improving: { icon: '📈', label: 'Improving',  color: '#22c55e', bg: 'rgba(34,197,94,0.08)',   border: 'rgba(34,197,94,0.2)'   },
  stable:    { icon: '➖', label: 'Stable',     color: '#f59e0b', bg: 'rgba(245,158,11,0.08)',  border: 'rgba(245,158,11,0.2)'  },
  declining: { icon: '📉', label: 'Declining',  color: '#ef4444', bg: 'rgba(239,68,68,0.08)',   border: 'rgba(239,68,68,0.2)'   },
  unknown:   { icon: '—',  label: 'No data',    color: '#4b5563', bg: 'rgba(75,85,99,0.08)',    border: 'rgba(75,85,99,0.2)'    },
};

const SUBJECT_ICON = {
  Mathematics:       '🔢',
  English:           '✍️',
  Physics:           '⚡',
  Chemistry:         '🧪',
  Biology:           '🧬',
  'Computer Science':'💻',
  Accountancy:       '📒',
  Economics:         '📉',
  'Business Studies':'🏢',
  History:           '🏛️',
  Geography:         '🌍',
  'Political Science':'⚖️',
  Sociology:         '👥',
  Psychology:        '🧠',
  'Fine Arts':       '🎨',
  Statistics:        '📊',
  'Second Language': '🗣️',
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function VelocityBadge({ velocity }) {
  if (velocity == null) return null;
  const positive = velocity >= 0;
  return (
    <span style={{
      fontSize: 11,
      fontWeight: 700,
      color: positive ? '#22c55e' : '#ef4444',
      background: positive ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
      border: `1px solid ${positive ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)'}`,
      borderRadius: 10,
      padding: '2px 7px',
    }}>
      {positive ? '+' : ''}{velocity.toFixed(1)}/yr
    </span>
  );
}

function SubjectRow({ subject, data }) {
  const trend  = data?.trend || 'unknown';
  const cfg    = TREND_CONFIG[trend] || TREND_CONFIG.unknown;
  const marks  = data?.latest_marks ?? null;
  const icon   = SUBJECT_ICON[subject] || '📖';

  return (
    <div style={AT.row}>
      {/* Subject name */}
      <div style={AT.subjectCol}>
        <span style={AT.subjectIcon}>{icon}</span>
        <span style={AT.subjectName}>{subject}</span>
      </div>

      {/* Latest marks mini-bar */}
      {marks !== null && (
        <div style={AT.marksCol}>
          <div style={AT.marksTrack}>
            <div style={{
              ...AT.marksBar,
              width: `${marks}%`,
              background: marks >= 75 ? '#22c55e' : marks >= 50 ? '#f59e0b' : '#ef4444',
            }} />
          </div>
          <span style={AT.marksText}>{marks}%</span>
        </div>
      )}

      {/* Trend badge + velocity */}
      <div style={AT.trendCol}>
        <span style={{ ...AT.trendBadge, color: cfg.color, background: cfg.bg, borderColor: cfg.border }}>
          {cfg.icon} {cfg.label}
        </span>
        <VelocityBadge velocity={data?.velocity} />
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function AcademicTrendCard({ subject_trends = {}, overall_learning_velocity }) {
  const subjects = Object.entries(subject_trends);

  // Sort: improving first, then stable, then declining
  const ORDER = { improving: 0, stable: 1, declining: 2, unknown: 3 };
  subjects.sort(([, a], [, b]) =>
    (ORDER[a?.trend] ?? 3) - (ORDER[b?.trend] ?? 3)
  );

  const improving = subjects.filter(([, d]) => d?.trend === 'improving').length;
  const declining = subjects.filter(([, d]) => d?.trend === 'declining').length;

  const velColor = (overall_learning_velocity ?? 0) >= 0 ? '#22c55e' : '#ef4444';

  return (
    <>
      <div style={AT.card}>
        {/* ── Header ── */}
        <div style={AT.header}>
          <div>
            <p style={AT.heading}>Academic Trends</p>
            <p style={AT.sub}>Subject performance across class levels</p>
          </div>
          {overall_learning_velocity != null && (
            <div style={AT.velWrap}>
              <span style={AT.velLabel}>Learning velocity</span>
              <span style={{ ...AT.velValue, color: velColor }}>
                {overall_learning_velocity >= 0 ? '+' : ''}{overall_learning_velocity}/yr
              </span>
            </div>
          )}
        </div>

        {/* ── Summary pills ── */}
        {subjects.length > 0 && (
          <div style={AT.summaryRow}>
            <span style={{ ...AT.sumPill, color: '#22c55e', background: 'rgba(34,197,94,0.08)', borderColor: 'rgba(34,197,94,0.2)' }}>
              📈 {improving} improving
            </span>
            <span style={{ ...AT.sumPill, color: '#f59e0b', background: 'rgba(245,158,11,0.08)', borderColor: 'rgba(245,158,11,0.2)' }}>
              ➖ {subjects.length - improving - declining} stable
            </span>
            {declining > 0 && (
              <span style={{ ...AT.sumPill, color: '#ef4444', background: 'rgba(239,68,68,0.08)', borderColor: 'rgba(239,68,68,0.2)' }}>
                📉 {declining} declining
              </span>
            )}
          </div>
        )}

        {/* ── Subject rows ── */}
        {subjects.length > 0 ? (
          <div style={AT.list}>
            {/* Column headers */}
            <div style={AT.colHeaders}>
              <span style={AT.colH}>Subject</span>
              <span style={AT.colH}>Latest Score</span>
              <span style={AT.colH}>Trend</span>
            </div>
            {subjects.map(([subject, data]) => (
              <SubjectRow key={subject} subject={subject} data={data} />
            ))}
          </div>
        ) : (
          <p style={AT.empty}>No academic data available. Complete the marks step to see trends.</p>
        )}
      </div>
      <style>{GLOBAL_STYLES}</style>
    </>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const AT = {
  card:        { background: '#111827', border: '1.5px solid #1f2937', borderRadius: 20, padding: '28px 28px 24px' },
  header:      { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, gap: 12 },
  heading:     { fontFamily: 'Syne, sans-serif', fontSize: 17, fontWeight: 700, color: '#f9fafb', margin: 0 },
  sub:         { fontSize: 13, color: '#6b7280', margin: '4px 0 0' },
  velWrap:     { textAlign: 'right', flexShrink: 0 },
  velLabel:    { fontSize: 10, color: '#6b7280', display: 'block', marginBottom: 2, textTransform: 'uppercase', letterSpacing: '0.05em' },
  velValue:    { fontSize: 18, fontWeight: 800 },
  summaryRow:  { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 },
  sumPill:     { fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 20, border: '1.5px solid' },
  list:        { display: 'flex', flexDirection: 'column', gap: 0 },
  colHeaders:  { display: 'grid', gridTemplateColumns: '1fr 120px 1fr', gap: 10, padding: '0 0 8px', borderBottom: '1px solid #1f2937', marginBottom: 8 },
  colH:        { fontSize: 10, fontWeight: 700, color: '#4b5563', textTransform: 'uppercase', letterSpacing: '0.06em' },
  row:         { display: 'grid', gridTemplateColumns: '1fr 120px 1fr', gap: 10, padding: '10px 0', borderBottom: '1px solid #0d1117', alignItems: 'center' },
  subjectCol:  { display: 'flex', alignItems: 'center', gap: 8 },
  subjectIcon: { fontSize: 16, flexShrink: 0 },
  subjectName: { fontSize: 13, color: '#d1d5db', fontWeight: 500 },
  marksCol:    { display: 'flex', alignItems: 'center', gap: 8 },
  marksTrack:  { flex: 1, height: 5, background: '#1f2937', borderRadius: 3, overflow: 'hidden' },
  marksBar:    { height: '100%', borderRadius: 3, transition: 'width 0.6s ease' },
  marksText:   { fontSize: 12, fontWeight: 700, color: '#9ca3af', minWidth: 32, textAlign: 'right' },
  trendCol:    { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  trendBadge:  { fontSize: 11, fontWeight: 600, padding: '3px 9px', borderRadius: 12, border: '1.5px solid' },
  empty:       { fontSize: 13, color: '#4b5563', textAlign: 'center', padding: '20px 0', margin: 0 },
};








