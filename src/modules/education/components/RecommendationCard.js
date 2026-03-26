/**
 * src/modules/education/components/RecommendationCard.js
 *
 * Hero card displaying the recommended stream, confidence score,
 * and rationale. Shown at the top of the Results Dashboard.
 *
 * Props:
 *   recommended_stream  — 'engineering' | 'medical' | 'commerce' | 'humanities'
 *   recommended_label   — string  e.g. "Computer Science"
 *   confidence          — number 0–100
 *   alternative_stream  — string (optional)
 *   alternative_label   — string (optional)
 *   rationale           — string
 */

const STREAM_CONFIG = {
  engineering: { icon: '💻', color: '#06b6d4', bg: 'rgba(6,182,212,0.08)'  },
  medical:     { icon: '🔬', color: '#22c55e', bg: 'rgba(34,197,94,0.08)'  },
  commerce:    { icon: '📊', color: '#f59e0b', bg: 'rgba(245,158,11,0.08)' },
  humanities:  { icon: '📚', color: '#a78bfa', bg: 'rgba(167,139,250,0.08)'},
};

const DEFAULT_CONFIG = { icon: '🎓', color: '#06b6d4', bg: 'rgba(6,182,212,0.08)' };

export default function RecommendationCard({
  recommended_stream,
  recommended_label,
  confidence,
  alternative_stream,
  alternative_label,
  rationale,
}) {
  const cfg  = STREAM_CONFIG[recommended_stream] || DEFAULT_CONFIG;
  const altCfg = STREAM_CONFIG[alternative_stream] || DEFAULT_CONFIG;
  const pct  = Math.max(0, Math.min(100, confidence ?? 0));

  // SVG confidence ring
  const radius = 36;
  const circ   = 2 * Math.PI * radius;
  const dash   = (pct / 100) * circ;

  return (
    <div style={{ ...RC.card, borderColor: `${cfg.color}30` }}>
      {/* Top row: icon + label + confidence ring */}
      <div style={RC.topRow}>
        {/* Stream icon badge */}
        <div style={{ ...RC.iconBadge, background: cfg.bg }}>
          <span style={RC.icon}>{cfg.icon}</span>
        </div>

        {/* Stream label */}
        <div style={RC.labelGroup}>
          <p style={RC.eyebrow}>Recommended Stream</p>
          <h2 style={{ ...RC.streamLabel, color: cfg.color }}>{recommended_label}</h2>
          <p style={RC.streamKey}>{recommended_stream?.toUpperCase()}</p>
        </div>

        {/* Confidence ring */}
        <div style={RC.ringWrap}>
          <svg width={88} height={88} style={{ transform: 'rotate(-90deg)' }}>
            {/* Track */}
            <circle
              cx={44} cy={44} r={radius}
              fill="none"
              stroke="#1f2937"
              strokeWidth={6}
            />
            {/* Progress */}
            <circle
              cx={44} cy={44} r={radius}
              fill="none"
              stroke={cfg.color}
              strokeWidth={6}
              strokeLinecap="round"
              strokeDasharray={`${dash} ${circ}`}
              style={{ filter: `drop-shadow(0 0 4px ${cfg.color}60)` }}
            />
          </svg>
          <div style={RC.ringLabel}>
            <span style={{ ...RC.ringPct, color: cfg.color }}>{pct}</span>
            <span style={RC.ringUnit}>%</span>
          </div>
          <p style={RC.ringText}>Confidence</p>
        </div>
      </div>

      {/* Rationale */}
      {rationale && (
        <p style={RC.rationale}>{rationale}</p>
      )}

      {/* Alternative stream pill */}
      {alternative_stream && (
        <div style={RC.altRow}>
          <span style={RC.altLabel}>Alternative:</span>
          <span style={{ ...RC.altPill, borderColor: `${altCfg.color}40`, color: altCfg.color, background: altCfg.bg }}>
            {altCfg.icon} {alternative_label || alternative_stream}
          </span>
        </div>
      )}
    </div>
  );
}

const RC = {
  card:        { background: '#111827', border: '1.5px solid #1f2937', borderRadius: 20, padding: '28px', marginBottom: 20 },
  topRow:      { display: 'flex', alignItems: 'center', gap: 20, marginBottom: 20 },
  iconBadge:   { width: 60, height: 60, borderRadius: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  icon:        { fontSize: 28 },
  labelGroup:  { flex: 1 },
  eyebrow:     { fontSize: 11, color: '#6b7280', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', margin: '0 0 4px' },
  streamLabel: { fontFamily: 'Syne, sans-serif', fontSize: 26, fontWeight: 800, margin: '0 0 2px', lineHeight: 1.1 },
  streamKey:   { fontSize: 11, color: '#4b5563', fontWeight: 600, letterSpacing: '0.1em', margin: 0 },
  ringWrap:    { position: 'relative', flexShrink: 0, textAlign: 'center' },
  ringLabel:   { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1, paddingBottom: 10 },
  ringPct:     { fontFamily: 'Syne, sans-serif', fontSize: 20, fontWeight: 800, lineHeight: 1 },
  ringUnit:    { fontSize: 11, color: '#9ca3af', alignSelf: 'flex-end', paddingBottom: 2 },
  ringText:    { fontSize: 10, color: '#6b7280', margin: '-4px 0 0', fontWeight: 600 },
  rationale:   { fontSize: 13, color: '#9ca3af', lineHeight: 1.7, margin: '0 0 16px', padding: '14px 16px', background: '#0d1117', borderRadius: 10, border: '1px solid #1f2937' },
  altRow:      { display: 'flex', alignItems: 'center', gap: 10 },
  altLabel:    { fontSize: 12, color: '#6b7280', fontWeight: 600 },
  altPill:     { fontSize: 12, fontWeight: 600, padding: '4px 12px', borderRadius: 20, border: '1.5px solid', display: 'inline-flex', alignItems: 'center', gap: 5 },
};








