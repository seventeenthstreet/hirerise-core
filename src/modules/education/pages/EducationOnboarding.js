/**
 * src/modules/education/pages/EducationOnboarding.js
 * Route: /education/onboarding
 *
 * Main shell for the Education Intelligence onboarding flow.
 * Renders the correct step page based on currentStep.
 * Resumes from the user's last saved step on return visits.
 *
 * UPDATED:
 *  - Added ReviewPage (step 5)
 *  - Added StepProgressBar component
 *  - Wires useEducationForm for cross-step localStorage persistence
 *  - next/head removed → font injected via useEffect (App Router safe)
 *  - useAuth from @/features/auth/components/AuthProvider
 */

import { useEffect }           from 'react';
import { useAuth }             from '@/features/auth/components/AuthProvider';
import { useEducation }        from '../hooks/useEducation';
import { useEducationForm }    from '../hooks/useEducationForm';
import StepProgressBar         from '../components/StepProgressBar';
import AcademicMarksPage       from './AcademicMarksPage';
import ActivitiesPage          from './ActivitiesPage';
import CognitiveTestPage       from './CognitiveTestPage';
import ReviewPage              from './ReviewPage';
import { ProfileForm }         from '../components/EducationForm';

// ─── Step metadata ────────────────────────────────────────────────────────────

const STEPS = ['profile', 'academics', 'activities', 'cognitive', 'review', 'complete'];

const STEP_LABELS = {
  profile:   'Your Profile',
  academics: 'Academic Marks',
  activities:'Activities',
  cognitive: 'Cognitive Test',
  review:    'Review',
  complete:  'Complete',
};

// Labels shown in StepProgressBar (shorter, mobile-friendly)
const PROGRESS_STEPS = ['Profile', 'Marks', 'Activities', 'Cognitive', 'Review'];

// ─── Component ────────────────────────────────────────────────────────────────

export default function EducationOnboarding() {
  const { user }      = useAuth();
  const education     = useEducation();
  const eduForm       = useEducationForm();

  const { currentStep, stepIndex, loadProfile } = education;

  // Inject Google Fonts once — avoids next/head (not available in App Router)
  useEffect(() => {
    if (document.getElementById('edu-fonts')) return;
    const link  = document.createElement('link');
    link.id     = 'edu-fonts';
    link.rel    = 'stylesheet';
    link.href   = 'https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Sans:wght@400;500;600&display=swap';
    document.head.appendChild(link);
  }, []);

  // Resume from last saved backend step on page load
  useEffect(() => {
    if (user?.uid) {
      loadProfile(user.uid).catch(() => {});
    }
  }, [user?.uid]); // eslint-disable-line react-hooks/exhaustive-deps

  // Progress bar index (excludes 'complete' from dot display)
  const progressIndex = Math.min(
    PROGRESS_STEPS.length - 1,
    STEPS.indexOf(currentStep)
  );

  // Final submit called from ReviewPage
  const handleFinalSubmit = async () => {
    await education.submitCognitive({
      ...eduForm.cognitive,
    }).catch(() => {});
    eduForm.reset();
  };

  return (
    <>
      <div style={S.root}>
        <header style={S.header}>
          <div style={S.headerRow}>
            <span style={S.brand}>🎓 Education Intelligence</span>
            <span style={S.stepLabel}>{STEP_LABELS[currentStep] ?? currentStep}</span>
          </div>

          {currentStep !== 'complete' && (
            <StepProgressBar
              steps={PROGRESS_STEPS}
              currentStep={progressIndex}
            />
          )}
        </header>

        <main style={S.main}>
          {currentStep === 'profile' && (
            <ProfileForm
              education={education}
              onProfileSaved={(profile) => eduForm.setProfile(profile)}
            />
          )}

          {currentStep === 'academics' && (
            <AcademicMarksPage
              education={education}
              rows={eduForm.academics}
              onRowsChange={eduForm.setAcademics}
            />
          )}

          {currentStep === 'activities' && (
            <ActivitiesPage
              education={education}
              rows={eduForm.activities}
              onRowsChange={eduForm.setActivities}
              selectedActivities={eduForm.selectedActivities}
              onSelectedChange={eduForm.setSelectedActivities}
            />
          )}

          {currentStep === 'cognitive' && (
            <CognitiveTestPage
              education={education}
              scores={eduForm.cognitive}
              onScoreChange={eduForm.setCognitiveScore}
              onRawAnswersChange={eduForm.setRawAnswers}
            />
          )}

          {currentStep === 'review' && (
            <ReviewPage
              education={education}
              formData={eduForm.form}
              onSubmit={handleFinalSubmit}
            />
          )}

          {currentStep === 'complete' && <CompleteCard />}
        </main>
      </div>

      <style>{GLOBAL_STYLES}</style>
    </>
  );
}

function CompleteCard() {
  return (
    <div className="edu-card" style={{ textAlign: 'center', padding: '60px 32px' }}>
      <div style={{ fontSize: 56, marginBottom: 16 }}>🎉</div>
      <h2 style={{ fontFamily: 'Syne, sans-serif', color: '#f9fafb', fontSize: 26, marginBottom: 10 }}>
        Onboarding Complete!
      </h2>
      <p style={{ color: '#6b7280', maxWidth: 380, margin: '0 auto', lineHeight: 1.7 }}>
        Your data has been saved. Stream analysis will be available on your dashboard
        once the AI engines have processed your profile.
      </p>
    </div>
  );
}

const S = {
  root:      { minHeight: '100vh', background: '#080c14', fontFamily: "'DM Sans', sans-serif", color: '#f9fafb' },
  header:    { background: '#0d1117', borderBottom: '1px solid #1f2937', paddingBottom: 0, position: 'sticky', top: 0, zIndex: 50 },
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', maxWidth: 820, margin: '0 auto', padding: '14px 24px 10px' },
  brand:     { fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: 15 },
  stepLabel: { fontSize: 13, color: '#6b7280' },
  main:      { maxWidth: 820, margin: '0 auto', padding: '36px 24px' },
};

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
  .edu-input:focus { border-color: #06b6d4; }
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
  .edu-btn-primary:hover:not(:disabled) { opacity: 0.9; transform: translateY(-1px); }
  .edu-btn-primary:disabled { opacity: 0.45; cursor: not-allowed; transform: none; }
  .edu-btn-secondary {
    background: transparent;
    color: #6b7280;
    border: 1.5px solid #1f2937;
  }
  .edu-btn-secondary:hover { color: #9ca3af; border-color: #374151; }
  .edu-error {
    background: rgba(239,68,68,0.08);
    border: 1px solid rgba(239,68,68,0.25);
    border-radius: 10px;
    padding: 11px 16px;
    color: #ef4444;
    font-size: 13px;
    margin-bottom: 18px;
  }
  .edu-row-grid-3 { display: grid; gap: 8px; align-items: center; }
  .edu-col-header { font-size: 11px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; }
  @media (max-width: 600px) {
    .edu-card { padding: 20px 16px; }
  }
`;








