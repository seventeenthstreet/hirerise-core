/**
 * src/modules/education/components/ActivitySelector.js
 *
 * Production-hardened chip-based multi-select for extracurricular activities.
 *
 * Improvements:
 * - Memoized derived selections
 * - Stable callback handlers
 * - Duplicate-safe custom additions
 * - Case-insensitive normalization for custom entries
 * - React memo optimization
 * - Safer disabled + callback guards
 * - Frozen static catalog
 */

import { memo, useCallback, useMemo, useState } from 'react';
import { GLOBAL_STYLES } from '../pages/EducationOnboarding';

// ───────────────────────────────────────────────────────────────────────────────
// Static activity catalogue
// ───────────────────────────────────────────────────────────────────────────────

const ACTIVITY_GROUPS = Object.freeze([
  {
    group: '💻 Technology',
    items: Object.freeze([
      'Coding / Programming',
      'Robotics',
      'AI & Machine Learning Club',
      'Cybersecurity',
      'App Development',
    ]),
  },
  {
    group: '🔬 Science & Math',
    items: Object.freeze([
      'Science Olympiad',
      'Math Competitions',
      'Physics Experiments',
      'Chemistry Club',
      'Astronomy',
    ]),
  },
  {
    group: '🗣 Communication',
    items: Object.freeze([
      'Debate & MUN',
      'Public Speaking',
      'Creative Writing',
      'School Newspaper',
      'Journalism',
    ]),
  },
  {
    group: '🎨 Arts & Culture',
    items: Object.freeze([
      'Drawing & Painting',
      'Music',
      'Dance',
      'Theatre / Drama',
      'Photography',
    ]),
  },
  {
    group: '⚽ Sports',
    items: Object.freeze([
      'Cricket',
      'Football',
      'Basketball',
      'Athletics',
      'Swimming',
      'Chess',
      'Table Tennis',
    ]),
  },
  {
    group: '🤝 Leadership & Service',
    items: Object.freeze([
      'Student Council',
      'Community Service',
      'NGO Volunteering',
      'Environment Club',
      'Teaching / Tutoring',
    ]),
  },
]);

function normalizeActivity(value) {
  return String(value || '').trim();
}

function ActivitySelectorComponent({
  selected = [],
  onChange,
  disabled = false,
}) {
  const [custom, setCustom] = useState('');

  const safeSelected = useMemo(
    () => Array.isArray(selected) ? selected : [],
    [selected]
  );

  const selectedSet = useMemo(
    () => new Set(safeSelected),
    [safeSelected]
  );

  const emitChange = useCallback(
    (next) => {
      if (typeof onChange === 'function') {
        onChange(next);
      }
    },
    [onChange]
  );

  const toggle = useCallback(
    (name) => {
      if (disabled) return;

      const exists = selectedSet.has(name);

      emitChange(
        exists
          ? safeSelected.filter((item) => item !== name)
          : [...safeSelected, name]
      );
    },
    [disabled, selectedSet, safeSelected, emitChange]
  );

  const addCustom = useCallback(() => {
    if (disabled) return;

    const trimmed = normalizeActivity(custom);

    if (!trimmed) {
      setCustom('');
      return;
    }

    const duplicate = safeSelected.some(
      (item) => item.toLowerCase() === trimmed.toLowerCase()
    );

    if (duplicate) {
      setCustom('');
      return;
    }

    emitChange([...safeSelected, trimmed]);
    setCustom('');
  }, [custom, disabled, safeSelected, emitChange]);

  const removeChip = useCallback(
    (name) => {
      if (disabled) return;
      emitChange(safeSelected.filter((item) => item !== name));
    },
    [disabled, safeSelected, emitChange]
  );

  const canAddCustom = custom.trim().length > 0 && !disabled;

  return (
    <>
      {safeSelected.length > 0 && (
        <div style={S.selectedStrip}>
          <p style={S.stripLabel}>
            Selected ({safeSelected.length})
          </p>

          <div style={S.chipRow}>
            {safeSelected.map((name) => (
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

      <div style={S.groupsWrap}>
        {ACTIVITY_GROUPS.map(({ group, items }) => (
          <div key={group}>
            <p style={S.groupLabel}>{group}</p>

            <div style={S.chipRow}>
              {items.map((item) => {
                const active = selectedSet.has(item);

                return (
                  <button
                    key={item}
                    type="button"
                    onClick={() => toggle(item)}
                    disabled={disabled}
                    style={active ? S.chipActive : S.chip}
                  >
                    {active ? '✓ ' : '+ '}
                    {item}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div style={S.customRow}>
        <input
          className="edu-input"
          placeholder="Add your own activity…"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addCustom();
            }
          }}
          disabled={disabled}
          style={S.customInput}
        />

        <button
          type="button"
          className="edu-btn edu-btn-secondary"
          onClick={addCustom}
          disabled={!canAddCustom}
          style={S.addButton}
        >
          Add
        </button>
      </div>

      <style>{GLOBAL_STYLES}</style>
      <style>{LOCAL_STYLES}</style>
    </>
  );
}

export default memo(ActivitySelectorComponent);

// ───────────────────────────────────────────────────────────────────────────────
// Styles
// ───────────────────────────────────────────────────────────────────────────────

const S = {
  groupsWrap: {
    display: 'flex',
    flexDirection: 'column',
    gap: 20,
  },

  selectedStrip: {
    background: 'rgba(6,182,212,0.05)',
    border: '1.5px solid rgba(6,182,212,0.15)',
    borderRadius: 12,
    padding: '12px 14px',
    marginBottom: 20,
  },

  stripLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: '#06b6d4',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    margin: '0 0 10px',
  },

  chipRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
  },

  groupLabel: {
    fontSize: 12,
    fontWeight: 600,
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    margin: '0 0 10px',
  },

  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 12,
    fontWeight: 500,
    padding: '6px 12px',
    borderRadius: 20,
    border: '1.5px solid #1f2937',
    background: 'transparent',
    color: '#9ca3af',
    cursor: 'pointer',
    transition: 'all 0.15s',
    whiteSpace: 'nowrap',
  },

  chipActive: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 12,
    fontWeight: 600,
    padding: '6px 12px',
    borderRadius: 20,
    border: '1.5px solid #06b6d4',
    background: 'rgba(6,182,212,0.1)',
    color: '#06b6d4',
    cursor: 'pointer',
    transition: 'all 0.15s',
    whiteSpace: 'nowrap',
  },

  chipSelected: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 12,
    fontWeight: 600,
    padding: '5px 10px',
    borderRadius: 20,
    border: '1.5px solid rgba(6,182,212,0.4)',
    background: 'rgba(6,182,212,0.08)',
    color: '#06b6d4',
    cursor: 'pointer',
    transition: 'all 0.15s',
  },

  chipX: {
    opacity: 0.5,
    fontSize: 10,
    marginLeft: 2,
  },

  customRow: {
    display: 'flex',
    gap: 10,
    marginTop: 20,
  },

  customInput: {
    flex: 1,
  },

  addButton: {
    flexShrink: 0,
    padding: '11px 18px',
  },
};

const LOCAL_STYLES = `
  button[style]:not(:disabled):hover {
    opacity: 0.85;
  }
`;