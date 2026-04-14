/**
 * src/modules/education/pages/ResultsDashboard.js
 * Route: /education/results/:studentId
 *
 * Production-hardened student stream analysis dashboard.
 *
 * Improvements:
 * - responsive two-column bug fix
 * - safer result normalization
 * - memoized loading/error screens
 * - hover anti-pattern removal
 * - redirect lifecycle safety
 * - stable derived debug fallbacks
 * - frozen styles
 */

import { memo, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/features/auth/components/AuthProvider';

import { useAnalysisResult } from '../hooks/useAnalysisResult';
import RecommendationCard from '../components/RecommendationCard';
import StreamChart from '../components/StreamChart';
import CognitiveRadar from '../components/CognitiveRadar';
import AcademicTrendCard from '../components/AcademicTrendCard';
import CareerOpportunityCard from '../components/CareerOpportunityCard';
import { GLOBAL_STYLES } from './EducationOnboarding';

// ───────────────────────────────────────────────────────────────────────────────
// Subcomponents
// ───────────────────────────────────────────────────────────────────────────────

const LoadingScreen = memo(function LoadingScreen({
  pollProgress,
}) {
  const steps = [
    'Reading academic marks',
    'Building cognitive profile',
    'Analyzing activities',
    'Calculating stream scores',
    'Predicting career success',
  ];

  return (
    <div style={RD.loadWrap}>
      <div style={RD.loadIconWrap}>
        <span style={RD.loadIcon}>🧠</span>
        <div style={RD.loadRing} />
      </div>

      <h2 style={RD.loadTitle}>
        Analyzing your academic profile…
      </h2>

      <p style={RD.loadSub}>
        Our AI engines are evaluating your academic marks,
        cognitive scores, and extracurricular activities.
      </p>

      <div
        style={RD.loadBarWrap}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pollProgress}
        aria-label="Analysis progress"
      >
        <div
          style={{
            ...RD.loadBar,
            width: `${pollProgress}%`,
          }}
        />
      </div>

      <div style={RD.loadSteps}>
        {steps.map((step, index) => {
          const done = pollProgress > (index + 1) * 18;

          return (
            <div key={step} style={RD.loadStep}>
              <span
                style={{
                  ...RD.loadStepDot,
                  background: done ? '#22c55e' : '#1f2937',
                  border: done
                    ? 'none'
                    : '1.5px solid #374151',
                }}
              >
                {done ? '✓' : ''}
              </span>

              <span
                style={{
                  ...RD.loadStepText,
                  color: done ? '#9ca3af' : '#4b5563',
                }}
              >
                {step}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
});

const ErrorScreen = memo(function ErrorScreen({
  message,
  onRetry,
}) {
  return (
    <div style={RD.errorWrap}>
      <span style={RD.errorIcon}>⚠️</span>

      <h2 style={RD.errorTitle}>
        Analysis Unavailable
      </h2>

      <p style={RD.errorMsg}>{message}</p>

      <button
        style={RD.retryBtn}
        onClick={onRetry}
        className="edu-btn-hover"
      >
        Try Again
      </button>
    </div>
  );
});

// ───────────────────────────────────────────────────────────────────────────────
// Main component
// ───────────────────────────────────────────────────────────────────────────────

function ResultsDashboardComponent({
  studentId: propStudentId,
}) {
  const { user } = useAuth();
  const router = useRouter();

  const studentId = propStudentId || user?.uid;

  const {
    result,
    loading,
    pollProgress,
    error,
    refetch,
  } = useAnalysisResult(studentId);

  useEffect(() => {
    if (!loading && !studentId) {
      router.replace('/education/onboarding');
    }
  }, [loading, studentId, router]);

  const normalized = useMemo(() => {
    const data = result || {};
    const debug = data._debug || {};

    return {
      recommended_stream: data.recommended_stream,
      recommended_label: data.recommended_label,
      confidence: data.confidence,
      alternative_stream: data.alternative_stream,
      alternative_label: data.alternative_label,
      stream_scores: data.stream_scores || {},
      rationale: data.rationale,
      top_careers: Array.isArray(data.top_careers)
        ? data.top_careers
        : [],
      cogScores: debug?.cognitive?.scores || {},
      profileLabel: debug?.cognitive?.profile_label,
      strengths: Array.isArray(
        debug?.cognitive?.strengths
      )
        ? debug.cognitive.strengths
        : [],
      subjectTrends:
        debug?.academic?.subject_trends || {},
      velocity:
        debug?.academic?.overall_learning_velocity,
    };
  }, [result]);

  if (loading) {
    return (
      <>
        <div style={RD.root}>
          <LoadingScreen pollProgress={pollProgress} />
        </div>
        <style>{GLOBAL_STYLES}</style>
        <style>{ANIM_STYLES}</style>
      </>
    );
  }

  if (error || !result) {
    return (
      <>
        <div style={RD.root}>
          <ErrorScreen
            message={
              error ||
              'We could not complete your analysis. Please try again.'
            }
            onRetry={refetch}
          />
        </div>
        <style>{GLOBAL_STYLES}</style>
        <style>{ANIM_STYLES}</style>
      </>
    );
  }

  return (
    <>
      <div style={RD.root}>
        <header style={RD.pageHeader}>
          <div style={RD.headerInner}>
            <div style={RD.headerLeft}>
              <span style={RD.brand}>
                🎓 Education Intelligence
              </span>
              <span style={RD.headerSep}>·</span>
              <span style={RD.headerPage}>
                Stream Analysis Results
              </span>
            </div>

            <button
              style={RD.retakeBtn}
              onClick={() =>
                router.push('/education/onboarding')
              }
              className="edu-btn-hover"
            >
              Retake Assessment
            </button>
          </div>
        </header>

        <main style={RD.main}>
          <RecommendationCard
            recommended_stream={
              normalized.recommended_stream
            }
            recommended_label={
              normalized.recommended_label
            }
            confidence={normalized.confidence}
            alternative_stream={
              normalized.alternative_stream
            }
            alternative_label={
              normalized.alternative_label
            }
            rationale={normalized.rationale}
          />

          <StreamChart
            stream_scores={normalized.stream_scores}
            recommended_stream={
              normalized.recommended_stream
            }
          />

          <div
            style={RD.twoCol}
            className="results-two-col"
          >
            <CognitiveRadar
              scores={normalized.cogScores}
              profile_label={normalized.profileLabel}
              strengths={normalized.strengths}
            />

            <AcademicTrendCard
              subject_trends={normalized.subjectTrends}
              overall_learning_velocity={
                normalized.velocity
              }
            />
          </div>

          <CareerOpportunityCard
            top_careers={normalized.top_careers}
          />

          <p style={RD.footer}>
            Analysis generated by HireRise Education
            Intelligence v1.0.0 · Results are based on
            self-reported data and should be used as a
            guide.
          </p>
        </main>
      </div>

      <style>{GLOBAL_STYLES}</style>
      <style>{ANIM_STYLES}</style>
    </>
  );
}

export default memo(ResultsDashboardComponent);

// ───────────────────────────────────────────────────────────────────────────────
// Styles
// ───────────────────────────────────────────────────────────────────────────────

const RD = Object.freeze({
  root: {
    minHeight: '100vh',
    background: '#080c14',
    fontFamily: "'DM Sans', sans-serif",
    color: '#f9fafb',
  },

  pageHeader: {
    background: '#0d1117',
    borderBottom: '1px solid #1f2937',
    position: 'sticky',
    top: 0,
    zIndex: 50,
  },

  headerInner: {
    maxWidth: 860,
    margin: '0 auto',
    padding: '14px 24px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },

  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },

  brand: {
    fontFamily: 'Syne, sans-serif',
    fontWeight: 700,
    fontSize: 14,
    color: '#f9fafb',
  },

  headerSep: {
    color: '#374151',
  },

  headerPage: {
    fontSize: 13,
    color: '#6b7280',
  },

  retakeBtn: {
    fontSize: 12,
    fontWeight: 600,
    color: '#6b7280',
    background: 'transparent',
    border: '1.5px solid #1f2937',
    borderRadius: 8,
    padding: '6px 14px',
    cursor: 'pointer',
    transition: 'opacity 0.2s',
  },

  main: {
    maxWidth: 860,
    margin: '0 auto',
    padding: '32px 24px 60px',
  },

  twoCol: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 20,
    marginTop: 20,
  },

  footer: {
    fontSize: 11,
    color: '#374151',
    textAlign: 'center',
    marginTop: 32,
    lineHeight: 1.6,
  },

  loadWrap: {
    maxWidth: 480,
    margin: '0 auto',
    padding: '80px 24px',
    textAlign: 'center',
  },

  loadIconWrap: {
    position: 'relative',
    width: 72,
    height: 72,
    margin: '0 auto 28px',
  },

  loadIcon: {
    fontSize: 40,
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },

  loadRing: {
    position: 'absolute',
    inset: 0,
    borderRadius: '50%',
    border: '3px solid transparent',
    borderTopColor: '#06b6d4',
    animation: 'spin 1s linear infinite',
  },

  loadTitle: {
    fontFamily: 'Syne, sans-serif',
    fontSize: 22,
    fontWeight: 700,
    color: '#f9fafb',
    margin: '0 0 12px',
  },

  loadSub: {
    fontSize: 14,
    color: '#6b7280',
    margin: '0 0 28px',
    lineHeight: 1.7,
  },

  loadBarWrap: {
    height: 4,
    background: '#1f2937',
    borderRadius: 4,
    overflow: 'hidden',
    marginBottom: 28,
  },

  loadBar: {
    height: '100%',
    background:
      'linear-gradient(90deg, #06b6d4, #6366f1)',
    borderRadius: 4,
    transition: 'width 0.5s ease',
  },

  loadSteps: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    textAlign: 'left',
    maxWidth: 280,
    margin: '0 auto',
  },

  loadStep: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },

  loadStepDot: {
    width: 18,
    height: 18,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 10,
    color: '#000',
    fontWeight: 700,
    flexShrink: 0,
  },

  loadStepText: {
    fontSize: 13,
  },

  errorWrap: {
    maxWidth: 420,
    margin: '0 auto',
    padding: '80px 24px',
    textAlign: 'center',
  },

  errorIcon: {
    fontSize: 48,
    display: 'block',
    marginBottom: 20,
  },

  errorTitle: {
    fontFamily: 'Syne, sans-serif',
    fontSize: 22,
    fontWeight: 700,
    color: '#f9fafb',
    margin: '0 0 12px',
  },

  errorMsg: {
    fontSize: 14,
    color: '#6b7280',
    lineHeight: 1.7,
    margin: '0 0 28px',
  },

  retryBtn: {
    padding: '12px 28px',
    background:
      'linear-gradient(135deg, #06b6d4, #6366f1)',
    color: '#fff',
    border: 'none',
    borderRadius: 11,
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'opacity 0.2s',
  },
});

const ANIM_STYLES = `
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .edu-btn-hover:hover {
    opacity: 0.85;
  }

  @media (max-width: 680px) {
    .results-two-col {
      grid-template-columns: 1fr !important;
    }
  }
`;