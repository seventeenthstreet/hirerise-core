/**
 * src/modules/education/pages/ReviewPage.js
 * Route: /education/onboarding (step: review)
 *
 * Production-hardened final review + submit page.
 *
 * Fixes:
 * - wired directly to submitReview()
 * - backward-compatible onSubmit fallback
 * - mobile cognitive grid fix
 * - memoized submit handler
 * - safer numeric score rendering
 * - duplicate-safe keys
 */

import { memo, useCallback } from 'react';
import { GLOBAL_STYLES } from './EducationOnboarding';

// ─── helpers ─────────────────────────────────────────────────────────────────

const LEVEL_LABEL = Object.freeze({
  class_8: 'Class 8',
  class_9: 'Class 9',
  class_10: 'Class 10',
  class_11: 'Class 11',
  class_12: 'Class 12',
  undergraduate: 'Undergraduate',
  postgraduate: 'Postgraduate',
});

const ACTIVITY_LEVEL_LABEL = Object.freeze({
  beginner: 'Beginner',
  intermediate: 'Intermediate',
  advanced: 'Advanced',
  national: 'National Level',
  international: 'International Level',
});

function clampScore(value) {
  const num = Number(value);
  if (Number.isNaN(num)) return 0;
  return Math.max(0, Math.min(100, num));
}

function getCognitiveLabel(value) {
  const v = clampScore(value);

  if (v < 25) return { text: 'Needs Work', color: '#ef4444' };
  if (v < 50) return { text: 'Average', color: '#f97316' };
  if (v < 75) return { text: 'Good', color: '#f59e0b' };
  if (v < 90) return { text: 'Strong', color: '#22c55e' };

  return { text: 'Excellent', color: '#06b6d4' };
}

const COGNITIVE_KEYS = Object.freeze([
  { key: 'analytical_score', label: 'Analytical Thinking' },
  { key: 'logical_score', label: 'Logical Reasoning' },
  { key: 'memory_score', label: 'Memory & Retention' },
  { key: 'communication_score', label: 'Communication' },
  { key: 'creativity_score', label: 'Creativity' },
]);

// ─── sub-components ───────────────────────────────────────────────────────────

const Section = memo(function Section({ title, children }) {
  return (
    <div style={S.section}>
      <p style={S.sectionTitle}>{title}</p>
      {children}
    </div>
  );
});

const Pill = memo(function Pill({ children, color }) {
  return (
    <span
      style={{
        ...S.pill,
        borderColor: color || '#1f2937',
        color: color || '#9ca3af',
      }}
    >
      {children}
    </span>
  );
});

// ─── main component ───────────────────────────────────────────────────────────

function ReviewPageComponent({
  education,
  formData,
  onSubmit,
}) {
  const { goBack, loading, error, submitReview } = education;

  const {
    profile,
    academics = [],
    activities = [],
    cognitive,
  } = formData || {};

  const handleSubmit = useCallback(() => {
    if (typeof onSubmit === 'function') {
      return onSubmit();
    }

    return submitReview();
  }, [onSubmit, submitReview]);

  return (
    <>
      <div className="edu-card">
        <h2 style={S.heading}>Review Your Profile</h2>
        <p style={S.subtext}>
          Check everything looks correct before submitting for stream analysis.
        </p>

        {error && <div className="edu-error">{error}</div>}

        <Section title="👤 Your Profile">
          <div style={S.row}>
            <span style={S.rowLabel}>Name</span>
            <span style={S.rowValue}>
              {profile?.name || '—'}
            </span>
          </div>

          <div style={S.row}>
            <span style={S.rowLabel}>Email</span>
            <span style={S.rowValue}>
              {profile?.email || '—'}
            </span>
          </div>

          <div style={S.row}>
            <span style={S.rowLabel}>Education Level</span>
            <span style={S.rowValue}>
              {LEVEL_LABEL[profile?.education_level] ||
                profile?.education_level ||
                '—'}
            </span>
          </div>
        </Section>

        <div style={S.divider} />

        <Section title="📚 Academic Marks">
          {academics.length > 0 ? (
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>Subject</th>
                  <th style={S.th}>Class</th>
                  <th style={{ ...S.th, textAlign: 'right' }}>
                    Marks
                  </th>
                </tr>
              </thead>
              <tbody>
                {academics.map((row, index) => {
                  const marks = Number(row?.marks) || 0;

                  return (
                    <tr
                      key={`${row?.subject}-${index}`}
                      style={index % 2 === 1 ? S.trAlt : {}}
                    >
                      <td style={S.td}>{row?.subject}</td>
                      <td style={S.td}>
                        {LEVEL_LABEL[row?.class_level] ||
                          row?.class_level}
                      </td>
                      <td
                        style={{
                          ...S.td,
                          textAlign: 'right',
                          fontWeight: 600,
                        }}
                      >
                        <span
                          style={{
                            color:
                              marks >= 75
                                ? '#22c55e'
                                : marks >= 50
                                ? '#f59e0b'
                                : '#ef4444',
                          }}
                        >
                          {marks}%
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <p style={S.empty}>No marks recorded.</p>
          )}
        </Section>

        <div style={S.divider} />

        <Section title="🏆 Extracurricular Activities">
          {activities.length > 0 ? (
            <div style={S.pillGroup}>
              {activities.map((activity, index) => (
                <Pill key={`${activity?.activity_name}-${index}`}>
                  {activity?.activity_name}
                  <span style={{ opacity: 0.5, marginLeft: 6 }}>
                    {ACTIVITY_LEVEL_LABEL[
                      activity?.activity_level
                    ] || activity?.activity_level}
                  </span>
                </Pill>
              ))}
            </div>
          ) : (
            <p style={S.empty}>No activities recorded.</p>
          )}
        </Section>

        <div style={S.divider} />

        <Section title="🧠 Cognitive Self-Assessment">
          {cognitive ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              {COGNITIVE_KEYS.map(({ key, label }) => {
                const val = clampScore(cognitive[key]);
                const { text, color } =
                  getCognitiveLabel(val);

                return (
                  <div
                    key={key}
                    style={S.cogRow}
                    className="review-cog-row"
                  >
                    <span style={S.cogLabel}>{label}</span>

                    <div style={S.cogBarWrap}>
                      <div
                        style={{
                          ...S.cogBar,
                          width: `${val}%`,
                          background: color,
                        }}
                      />
                    </div>

                    <span
                      style={{ ...S.cogScore, color }}
                    >
                      {val}
                    </span>

                    <span
                      style={{ ...S.cogText, color }}
                    >
                      {text}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p style={S.empty}>No cognitive data recorded.</p>
          )}
        </Section>

        <div style={S.actionRow}>
          <button
            className="edu-btn edu-btn-secondary"
            onClick={goBack}
            disabled={loading}
          >
            ← Back
          </button>

          <button
            className="edu-btn edu-btn-primary"
            style={{ flex: 1 }}
            disabled={loading}
            onClick={handleSubmit}
          >
            {loading
              ? 'Submitting…'
              : '🚀 Submit for Analysis'}
          </button>
        </div>

        <p style={S.disclaimer}>
          Your data is saved securely. Stream analysis results
          will appear on your dashboard once the AI engines
          have processed your profile.
        </p>
      </div>

      <style>{GLOBAL_STYLES}</style>
      <style>{LOCAL_STYLES}</style>
    </>
  );
}

export default memo(ReviewPageComponent);

// ─── styles ───────────────────────────────────────────────────────────────────

const S = {
  heading: { fontFamily: 'Syne, sans-serif', fontSize: 22, fontWeight: 700, color: '#f9fafb', marginBottom: 6, marginTop: 0 },
  subtext: { color: '#6b7280', fontSize: 14, marginBottom: 28, marginTop: 0 },
  section: { marginBottom: 0 },
  sectionTitle: { fontSize: 13, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 14, marginTop: 0 },
  divider: { height: 1, background: '#1f2937', margin: '24px 0' },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', borderBottom: '1px solid #111827' },
  rowLabel: { fontSize: 13, color: '#6b7280' },
  rowValue: { fontSize: 13, color: '#f3f4f6', fontWeight: 500 },
  table: { width: '100%', borderCollapse: 'collapse' },
  th: { fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', padding: '0 0 8px', textAlign: 'left' },
  td: { fontSize: 13, color: '#d1d5db', padding: '8px 0', borderBottom: '1px solid #111827' },
  trAlt: { background: 'rgba(255,255,255,0.01)' },
  pillGroup: { display: 'flex', flexWrap: 'wrap', gap: 8 },
  pill: { display: 'inline-flex', alignItems: 'center', fontSize: 12, fontWeight: 500, padding: '4px 12px', borderRadius: 20, border: '1.5px solid', background: 'rgba(255,255,255,0.03)' },
  empty: { fontSize: 13, color: '#4b5563', margin: 0 },
  cogRow: { display: 'grid', gridTemplateColumns: '1fr 120px 32px 72px', alignItems: 'center', gap: 10 },
  cogLabel: { fontSize: 13, color: '#d1d5db' },
  cogBarWrap: { height: 6, background: '#1f2937', borderRadius: 4, overflow: 'hidden' },
  cogBar: { height: '100%', borderRadius: 4, transition: 'width 0.4s ease' },
  cogScore: { fontSize: 14, fontWeight: 700, textAlign: 'right' },
  cogText: { fontSize: 11, textAlign: 'right' },
  actionRow: { display: 'flex', gap: 12, marginTop: 32 },
  disclaimer: { marginTop: 18, marginBottom: 0, fontSize: 12, color: '#374151', textAlign: 'center', lineHeight: 1.6 },
};

const LOCAL_STYLES = `
  @media (max-width: 600px) {
    .review-cog-row {
      grid-template-columns: 1fr 80px 28px 60px !important;
      gap: 6px !important;
    }
  }
`;