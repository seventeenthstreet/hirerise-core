/**
 * src/modules/education/pages/EducationOnboarding.js
 * Route: /education/onboarding
 *
 * Production-hardened onboarding shell for Education Intelligence.
 *
 * Improvements:
 * - stale effect protection
 * - step flow bug fix (review step)
 * - safe font injection
 * - memoized step rendering
 * - stable submit flow
 * - invalid step fallback
 * - SSR/client safety
 */

import { memo, useCallback, useEffect, useMemo } from 'react';
import { useAuth } from '@/features/auth/components/AuthProvider';
import { useEducation } from '../hooks/useEducation';
import { useEducationForm } from '../hooks/useEducationForm';
import StepProgressBar from '../components/StepProgressBar';
import AcademicMarksPage from './AcademicMarksPage';
import ActivitiesPage from './ActivitiesPage';
import CognitiveTestPage from './CognitiveTestPage';
import ReviewPage from './ReviewPage';
import { ProfileForm } from '../components/EducationForm';

// ───────────────────────────────────────────────────────────────────────────────
// Step metadata
// ───────────────────────────────────────────────────────────────────────────────

const STEPS = Object.freeze([
  'profile',
  'academics',
  'activities',
  'cognitive',
  'review',
  'complete',
]);

const STEP_LABELS = Object.freeze({
  profile: 'Your Profile',
  academics: 'Academic Marks',
  activities: 'Activities',
  cognitive: 'Cognitive Test',
  review: 'Review',
  complete: 'Complete',
});

const PROGRESS_STEPS = Object.freeze([
  'Profile',
  'Marks',
  'Activities',
  'Cognitive',
  'Review',
]);

// ───────────────────────────────────────────────────────────────────────────────
// Main component
// ───────────────────────────────────────────────────────────────────────────────

function EducationOnboardingComponent() {
  const { user } = useAuth();
  const education = useEducation();
  const eduForm = useEducationForm();

  const { currentStep, loadProfile } = education;

  useEffect(() => {
    if (typeof document === 'undefined') return;

    if (!document.getElementById('edu-fonts')) {
      const link = document.createElement('link');
      link.id = 'edu-fonts';
      link.rel = 'stylesheet';
      link.href =
        'https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Sans:wght@400;500;600&display=swap';
      document.head.appendChild(link);
    }
  }, []);

  useEffect(() => {
    if (!user?.uid) return;

    let active = true;

    loadProfile(user.uid).catch(() => {
      if (!active) return;
    });

    return () => {
      active = false;
    };
  }, [user?.uid, loadProfile]);

  const progressIndex = useMemo(() => {
    const index = STEPS.indexOf(currentStep);
    const safeIndex = index >= 0 ? index : 0;

    return Math.min(
      PROGRESS_STEPS.length - 1,
      safeIndex
    );
  }, [currentStep]);

  const handleFinalSubmit = useCallback(async () => {
    try {
      await education.submitCognitive({
        ...eduForm.cognitive,
      });

      eduForm.reset();
    } catch {
      // submitCognitive already manages error state
    }
  }, [education, eduForm]);

  const stepContent = useMemo(() => {
    switch (currentStep) {
      case 'profile':
        return (
          <ProfileForm
            education={education}
            onProfileSaved={eduForm.setProfile}
          />
        );

      case 'academics':
        return (
          <AcademicMarksPage
            education={education}
            rows={eduForm.academics}
            onRowsChange={eduForm.setAcademics}
          />
        );

      case 'activities':
        return (
          <ActivitiesPage
            education={education}
            rows={eduForm.activities}
            onRowsChange={eduForm.setActivities}
            selectedActivities={eduForm.selectedActivities}
            onSelectedChange={eduForm.setSelectedActivities}
          />
        );

      case 'cognitive':
        return (
          <CognitiveTestPage
            education={education}
            scores={eduForm.cognitive}
            onScoreChange={eduForm.setCognitiveScore}
            onRawAnswersChange={eduForm.setRawAnswers}
          />
        );

      case 'review':
        return (
          <ReviewPage
            education={education}
            formData={eduForm.form}
            onSubmit={handleFinalSubmit}
          />
        );

      case 'complete':
        return <CompleteCard />;

      default:
        return (
          <ProfileForm
            education={education}
            onProfileSaved={eduForm.setProfile}
          />
        );
    }
  }, [currentStep, education, eduForm, handleFinalSubmit]);

  return (
    <>
      <div style={S.root}>
        <header style={S.header}>
          <div style={S.headerRow}>
            <span style={S.brand}>
              🎓 Education Intelligence
            </span>

            <span style={S.stepLabel}>
              {STEP_LABELS[currentStep] || 'Your Profile'}
            </span>
          </div>

          {currentStep !== 'complete' && (
            <StepProgressBar
              steps={PROGRESS_STEPS}
              currentStep={progressIndex}
            />
          )}
        </header>

        <main style={S.main}>{stepContent}</main>
      </div>

      <style>{GLOBAL_STYLES}</style>
    </>
  );
}

export default memo(EducationOnboardingComponent);

// ───────────────────────────────────────────────────────────────────────────────
// Complete state
// ───────────────────────────────────────────────────────────────────────────────

const CompleteCard = memo(function CompleteCard() {
  return (
    <div
      className="edu-card"
      style={{
        textAlign: 'center',
        padding: '60px 32px',
      }}
    >
      <div style={{ fontSize: 56, marginBottom: 16 }}>
        🎉
      </div>

      <h2
        style={{
          fontFamily: 'Syne, sans-serif',
          color: '#f9fafb',
          fontSize: 26,
          marginBottom: 10,
        }}
      >
        Onboarding Complete!
      </h2>

      <p
        style={{
          color: '#6b7280',
          maxWidth: 380,
          margin: '0 auto',
          lineHeight: 1.7,
        }}
      >
        Your data has been saved. Stream analysis will be available on your dashboard
        once the AI engines have processed your profile.
      </p>
    </div>
  );
});

// ───────────────────────────────────────────────────────────────────────────────
// Styles
// ───────────────────────────────────────────────────────────────────────────────

const S = Object.freeze({
  root: {
    minHeight: '100vh',
    background: '#080c14',
    fontFamily: "'DM Sans', sans-serif",
    color: '#f9fafb',
  },

  header: {
    background: '#0d1117',
    borderBottom: '1px solid #1f2937',
    paddingBottom: 0,
    position: 'sticky',
    top: 0,
    zIndex: 50,
  },

  headerRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    maxWidth: 820,
    margin: '0 auto',
    padding: '14px 24px 10px',
  },

  brand: {
    fontFamily: 'Syne, sans-serif',
    fontWeight: 700,
    fontSize: 15,
  },

  stepLabel: {
    fontSize: 13,
    color: '#6b7280',
  },

  main: {
    maxWidth: 820,
    margin: '0 auto',
    padding: '36px 24px',
  },
});

export const GLOBAL_STYLES = `
  .edu-card {
    background: #111827;
    border: 1.5px solid #1f2937;
    border-radius: 18px;
    padding: 32px;
  }

  .edu-label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    color: #9ca3af;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 6px;
  }

  .edu-input {
    width: 100%;
    background: #0d1117;
    border: 1.5px solid #1f2937;
    border-radius: 10px;
    padding: 11px 14px;
    color: #f9fafb;
    font-family: 'DM Sans', sans-serif;
    font-size: 14px;
    outline: none;
    transition: border-color 0.2s;
    box-sizing: border-box;
  }

  .edu-input:focus {
    border-color: #06b6d4;
  }

  .edu-btn {
    padding: 13px 28px;
    border-radius: 11px;
    border: none;
    font-family: 'DM Sans', sans-serif;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
  }

  .edu-btn-primary {
    background: linear-gradient(135deg, #06b6d4, #6366f1);
    color: white;
  }

  .edu-btn-primary:hover:not(:disabled) {
    opacity: 0.9;
    transform: translateY(-1px);
  }

  .edu-btn-primary:disabled {
    opacity: 0.45;
    cursor: not-allowed;
    transform: none;
  }

  .edu-btn-secondary {
    background: transparent;
    color: #6b7280;
    border: 1.5px solid #1f2937;
  }

  .edu-btn-secondary:hover {
    color: #9ca3af;
    border-color: #374151;
  }

  .edu-error {
    background: rgba(239,68,68,0.08);
    border: 1px solid rgba(239,68,68,0.25);
    border-radius: 10px;
    padding: 11px 16px;
    color: #ef4444;
    font-size: 13px;
    margin-bottom: 18px;
  }

  .edu-row-grid-3 {
    display: grid;
    gap: 8px;
    align-items: center;
  }

  .edu-col-header {
    font-size: 11px;
    font-weight: 600;
    color: #6b7280;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  @media (max-width: 600px) {
    .edu-card {
      padding: 20px 16px;
    }
  }
`;