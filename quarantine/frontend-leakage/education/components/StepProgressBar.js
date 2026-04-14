/**
 * src/modules/education/components/StepProgressBar.js
 *
 * Production-hardened reusable step progress indicator.
 *
 * Improvements:
 * - React memoization
 * - safe step index normalization
 * - progress percentage clamping
 * - duplicate-safe keys
 * - responsive label fix
 * - accessibility improvements
 * - frozen styles
 */

import { memo, useMemo } from 'react';

// ───────────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────────

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeSteps(steps) {
  return Array.isArray(steps) ? steps : [];
}

function StepProgressBarComponent({ steps, currentStep }) {
  const safeSteps = useMemo(() => normalizeSteps(steps), [steps]);

  const totalSteps = safeSteps.length;

  const safeCurrentStep = useMemo(() => {
    if (totalSteps === 0) return 0;
    return clamp(Number(currentStep) || 0, 0, totalSteps - 1);
  }, [currentStep, totalSteps]);

  const pct = useMemo(() => {
    if (totalSteps <= 1) return 0;
    return Math.round((safeCurrentStep / (totalSteps - 1)) * 100);
  }, [safeCurrentStep, totalSteps]);

  const counterText =
    totalSteps > 0
      ? `Step ${safeCurrentStep + 1} of ${totalSteps}`
      : 'No steps';

  return (
    <div style={S.wrap}>
      <div style={S.labelRow}>
        <span style={S.counter}>{counterText}</span>
        <span style={S.pctLabel}>{pct}% complete</span>
      </div>

      <div
        style={S.track}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label="Onboarding progress"
      >
        <div
          style={{
            ...S.fill,
            width: `${pct}%`,
          }}
        />
      </div>

      {totalSteps > 0 && (
        <div style={S.dotsRow}>
          {safeSteps.map((label, index) => {
            const done = index < safeCurrentStep;
            const active = index === safeCurrentStep;

            return (
              <div
                key={`${label}-${index}`}
                style={S.dotGroup}
              >
                <div
                  style={{
                    ...S.dot,
                    ...(active ? S.dotActive : {}),
                    ...(done ? S.dotDone : {}),
                  }}
                >
                  {done ? '✓' : index + 1}
                </div>

                <span
                  className="edu-step-label"
                  style={{
                    ...S.dotLabel,
                    ...(active ? S.dotLabelActive : {}),
                    ...(done ? S.dotLabelDone : {}),
                  }}
                >
                  {label}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <style>{STYLES}</style>
    </div>
  );
}

export default memo(StepProgressBarComponent);

// ───────────────────────────────────────────────────────────────────────────────
// Styles
// ───────────────────────────────────────────────────────────────────────────────

const S = Object.freeze({
  wrap: {
    padding: '14px 24px 0',
  },

  labelRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    maxWidth: 820,
    margin: '0 auto',
    paddingBottom: 10,
  },

  counter: {
    fontFamily: 'Syne, sans-serif',
    fontWeight: 700,
    fontSize: 14,
    color: '#f9fafb',
  },

  pctLabel: {
    fontSize: 12,
    color: '#6b7280',
  },

  track: {
    height: 3,
    background: '#1f2937',
    borderRadius: 2,
  },

  fill: {
    height: '100%',
    background: 'linear-gradient(90deg, #06b6d4, #6366f1)',
    borderRadius: 2,
    transition: 'width 0.45s ease',
  },

  dotsRow: {
    display: 'flex',
    justifyContent: 'center',
    gap: 0,
    padding: '12px 0',
    maxWidth: 820,
    margin: '0 auto',
  },

  dotGroup: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 5,
    flex: 1,
  },

  dot: {
    width: 26,
    height: 26,
    borderRadius: '50%',
    border: '2px solid #374151',
    background: 'transparent',
    color: '#6b7280',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 11,
    fontWeight: 700,
    transition: 'all 0.2s',
  },

  dotActive: {
    borderColor: '#06b6d4',
    color: '#06b6d4',
    background: 'rgba(6,182,212,0.12)',
  },

  dotDone: {
    borderColor: '#22c55e',
    background: '#22c55e',
    color: '#000',
    border: 'none',
  },

  dotLabel: {
    fontSize: 10,
    color: '#4b5563',
    whiteSpace: 'nowrap',
    textAlign: 'center',
  },

  dotLabelActive: {
    color: '#06b6d4',
  },

  dotLabelDone: {
    color: '#22c55e',
  },
});

const STYLES = `
  @media (max-width: 520px) {
    .edu-step-label {
      display: none;
    }
  }
`;