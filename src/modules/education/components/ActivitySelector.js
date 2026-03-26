/**
 * src/modules/education/components/ActivitySelector.js
 *
 * Chip-based multi-select for extracurricular activities.
 * Replaces the plain text-input row approach with a more mobile-friendly UI.
 *
 * Props:
 *   selected   — string[]          currently selected activity names
 *   onChange   — (string[]) => void
 *   disabled?  — boolean
 */

import { useState } from 'react';
import { GLOBAL_STYLES } from '../pages/EducationOnboarding';

// ─── Preset activity catalogue ────────────────────────────────────────────────

const ACTIVITY_GROUPS = [
  {
    group: '💻 Technology',
    items: ['Coding / Programming', 'Robotics', 'AI & Machine Learning Club', 'Cybersecurity', 'App Development'],
  },
  {
    group: '🔬 Science & Math',
    items: ['Science Olympiad', 'Math Competitions', 'Physics Experiments', 'Chemistry Club', 'Astronomy'],
  },
  {
    group: '🗣 Communication',
    items: ['Debate & MUN', 'Public Speaking', 'Creative Writing', 'School Newspaper', 'Journalism'],
  },
  {
    group: '🎨 Arts & Culture',
    items: ['Drawing & Painting', 'Music', 'Dance', 'Theatre / Drama', 'Photography'],
  },
  {
    group: '⚽ Sports',
    items: ['Cricket', 'Football', 'Basketball', 'Athletics', 'Swimming', 'Chess', 'Table Tennis'],
  },
  {
    group: '🤝 Leadership & Service',
    items: ['Student Council', 'Community Service', 'NGO Volunteering', 'Environment Club', 'Teaching / Tutoring'],
  },
];

// ─── Component ────────────────────────────────────────────────────────────────

export default function ActivitySelector({ selected = [], onChange, disabled }) {
  const [custom, setCustom] = useState('');

  const toggle = (name) => {
    if (disabled) return;
    const has = selected.includes(name);
    onChange(has ? selected.filter((a) => a !== name) : [...selected, name]);
  };

  const addCustom = () => {
    const trimmed = custom.trim();
    if (!trimmed || selected.includes(trimmed)) { setCustom(''); return; }
    onChange([...selected, trimmed]);
    setCustom('');
  };

  const removeChip = (name) => onChange(selected.filter((a) => a !== name));

  return (
    <>
      {/* ── Selected chips strip ── */}
      {selected.length > 0 && (
        <div style={S.selectedStrip}>
          <p style={S.stripLabel}>Selected ({selected.length})</p>
          <div style={S.chipRow}>
            {selected.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => removeChip(name)}
                disabled={disabled}
                style={S.chipSelected}
              >
                ✓ {name}
                {!disabled && <span style={S.chipX}>✕</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Activity groups ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {ACTIVITY_GROUPS.map(({ group, items }) => (
          <div key={group}>
            <p style={S.groupLabel}>{group}</p>
            <div style={S.chipRow}>
              {items.map((item) => {
                const active = selected.includes(item);
                return (
                  <button
                    key={item}
                    type="button"
                    onClick={() => toggle(item)}
                    disabled={disabled}
                    style={active ? S.chipActive : S.chip}
                  >
                    {active ? '✓ ' : '+ '}{item}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* ── Custom activity input ── */}
      <div style={S.customRow}>
        <input
          className="edu-input"
          placeholder="Add your own activity…"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustom(); } }}
          disabled={disabled}
          style={{ flex: 1 }}
        />
        <button
          type="button"
          className="edu-btn edu-btn-secondary"
          onClick={addCustom}
          disabled={!custom.trim() || disabled}
          style={{ flexShrink: 0, padding: '11px 18px' }}
        >
          Add
        </button>
      </div>

      <style>{GLOBAL_STYLES}</style>
      <style>{LOCAL_STYLES}</style>
    </>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const S = {
  selectedStrip: { background: 'rgba(6,182,212,0.05)', border: '1.5px solid rgba(6,182,212,0.15)', borderRadius: 12, padding: '12px 14px', marginBottom: 20 },
  stripLabel:    { fontSize: 11, fontWeight: 600, color: '#06b6d4', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 10px' },
  chipRow:       { display: 'flex', flexWrap: 'wrap', gap: 8 },
  groupLabel:    { fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 10px' },
  chip:          { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 500, padding: '6px 12px', borderRadius: 20, border: '1.5px solid #1f2937', background: 'transparent', color: '#9ca3af', cursor: 'pointer', transition: 'all 0.15s', whiteSpace: 'nowrap' },
  chipActive:    { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600, padding: '6px 12px', borderRadius: 20, border: '1.5px solid #06b6d4', background: 'rgba(6,182,212,0.1)', color: '#06b6d4', cursor: 'pointer', transition: 'all 0.15s', whiteSpace: 'nowrap' },
  chipSelected:  { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, padding: '5px 10px', borderRadius: 20, border: '1.5px solid rgba(6,182,212,0.4)', background: 'rgba(6,182,212,0.08)', color: '#06b6d4', cursor: 'pointer', transition: 'all 0.15s' },
  chipX:         { opacity: 0.5, fontSize: 10, marginLeft: 2 },
  customRow:     { display: 'flex', gap: 10, marginTop: 20 },
};

const LOCAL_STYLES = `
  button[style]:not(:disabled):hover { opacity: 0.85; }
`;








