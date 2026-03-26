/**
 * src/modules/education/pages/ResultsDashboard.js
 * Route: /education/results/:studentId
 *
 * Student Stream Analysis Results Dashboard.
 * Fetches the cached AI engine result and renders all four visual panels.
 *
 * Layout:
 *   ① RecommendationCard  — hero: recommended stream + confidence ring
 *   ② StreamChart          — horizontal bar chart of all four streams
 *   ③ CognitiveRadar       — pentagon radar of five cognitive dimensions
 *   ④ AcademicTrendCard    — per-subject trend table with velocity
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth }   from '@/features/auth/components/AuthProvider';

import { useAnalysisResult } from '../hooks/useAnalysisResult';
import RecommendationCard    from '../components/RecommendationCard';
import StreamChart           from '../components/StreamChart';
import CognitiveRadar        from '../components/CognitiveRadar';
import AcademicTrendCard     from '../components/AcademicTrendCard';
import CareerOpportunityCard from '../components/CareerOpportunityCard';
import { GLOBAL_STYLES }     from './EducationOnboarding';

// ─── Loading screen ───────────────────────────────────────────────────────────

function LoadingScreen({ pollProgress }) {
  return (
    <div style={RD.loadWrap}>
      {/* Animated brain icon */}
      <div style={RD.loadIconWrap}>
        <span style={RD.loadIcon}>🧠</span>
        <div style={RD.loadRing} />
      </div>

      <h2 style={RD.loadTitle}>Analyzing your academic profile…</h2>
      <p style={RD.loadSub}>
        Our AI engines are evaluating your academic marks, cognitive scores,
        and extracurricular activities.
      </p>

      {/* Progress bar */}
      <div style={RD.loadBarWrap}>
        <div style={{ ...RD.loadBar, width: `${pollProgress}%` }} />
      </div>

      {/* Step labels */}
      <div style={RD.loadSteps}>
        {[
          'Reading academic marks',
          'Building cognitive profile',
          'Analyzing activities',
          'Calculating stream scores',
          'Predicting career success',
        ].map((step, i) => {
          const done = pollProgress > (i + 1) * 18;
          return (
            <div key={step} style={RD.loadStep}>
              <span style={{ ...RD.loadStepDot, background: done ? '#22c55e' : '#1f2937', border: done ? 'none' : '1.5px solid #374151' }}>
                {done ? '✓' : ''}
              </span>
              <span style={{ ...RD.loadStepText, color: done ? '#9ca3af' : '#4b5563' }}>{step}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Error screen ─────────────────────────────────────────────────────────────

function ErrorScreen({ message, onRetry }) {
  return (
    <div style={RD.errorWrap}>
      <span style={RD.errorIcon}>⚠️</span>
      <h2 style={RD.errorTitle}>Analysis Unavailable</h2>
      <p style={RD.errorMsg}>{message}</p>
      <button
        style={RD.retryBtn}
        onClick={onRetry}
        onMouseEnter={e => { e.target.style.opacity = '0.85'; }}
        onMouseLeave={e => { e.target.style.opacity = '1'; }}
      >
        Try Again
      </button>
    </div>
  );
}

// ─── Main dashboard ───────────────────────────────────────────────────────────

export default function ResultsDashboard({ studentId: propStudentId }) {
  const { user }    = useAuth();
  const router      = useRouter();

  // Use prop if provided (from page.tsx params), fallback to logged-in user UID
  const studentId   = propStudentId || user?.uid;

  const { result, loading, polling, pollProgress, error, refetch } =
    useAnalysisResult(studentId);

  // If no studentId at all, redirect to onboarding
  useEffect(() => {
    if (!loading && !studentId) {
      router.replace('/education/onboarding');
    }
  }, [loading, studentId, router]);

  // ── Loading ────────────────────────────────────────────────────────────────
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

  // ── Error ──────────────────────────────────────────────────────────────────
  if (error || !result) {
    return (
      <>
        <div style={RD.root}>
          <ErrorScreen
            message={error || 'We could not complete your analysis. Please try again.'}
            onRetry={refetch}
          />
        </div>
        <style>{GLOBAL_STYLES}</style>
      </>
    );
  }

  // ── Destructure result ─────────────────────────────────────────────────────
  const {
    recommended_stream,
    recommended_label,
    confidence,
    alternative_stream,
    alternative_label,
    stream_scores,
    rationale,
    top_careers,
    _debug,
  } = result;

  const cogScores    = _debug?.cognitive?.scores     || {};
  const profileLabel = _debug?.cognitive?.profile_label;
  const strengths    = _debug?.cognitive?.strengths  || [];
  const subjectTrends= _debug?.academic?.subject_trends || {};
  const velocity     = _debug?.academic?.overall_learning_velocity;

  // ── Dashboard ──────────────────────────────────────────────────────────────
  return (
    <>
      <div style={RD.root}>
        {/* ── Page header ── */}
        <header style={RD.pageHeader}>
          <div style={RD.headerInner}>
            <div style={RD.headerLeft}>
              <span style={RD.brand}>🎓 Education Intelligence</span>
              <span style={RD.headerSep}>·</span>
              <span style={RD.headerPage}>Stream Analysis Results</span>
            </div>
            <button
              style={RD.retakeBtn}
              onClick={() => router.push('/education/onboarding')}
            >
              Retake Assessment
            </button>
          </div>
        </header>

        {/* ── Content ── */}
        <main style={RD.main}>

          {/* ① Recommendation hero */}
          <RecommendationCard
            recommended_stream={recommended_stream}
            recommended_label={recommended_label}
            confidence={confidence}
            alternative_stream={alternative_stream}
            alternative_label={alternative_label}
            rationale={rationale}
          />

          {/* ② Stream chart — full width */}
          <StreamChart
            stream_scores={stream_scores}
            recommended_stream={recommended_stream}
          />

          {/* ③④ Two-column grid on wide screens */}
          <div style={RD.twoCol}>
            <CognitiveRadar
              scores={cogScores}
              profile_label={profileLabel}
              strengths={strengths}
            />
            <AcademicTrendCard
              subject_trends={subjectTrends}
              overall_learning_velocity={velocity}
            />
          </div>

          {/* ⑤ Career Opportunities — full width */}
          <CareerOpportunityCard top_careers={top_careers} />

          {/* ── Footer note ── */}
          <p style={RD.footer}>
            Analysis generated by HireRise Education Intelligence v1.0.0 ·
            Results are based on self-reported data and should be used as a guide.
          </p>
        </main>
      </div>

      <style>{GLOBAL_STYLES}</style>
      <style>{ANIM_STYLES}</style>
    </>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const RD = {
  root:        { minHeight: '100vh', background: '#080c14', fontFamily: "'DM Sans', sans-serif", color: '#f9fafb' },

  // Header
  pageHeader:  { background: '#0d1117', borderBottom: '1px solid #1f2937', position: 'sticky', top: 0, zIndex: 50 },
  headerInner: { maxWidth: 860, margin: '0 auto', padding: '14px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  headerLeft:  { display: 'flex', alignItems: 'center', gap: 8 },
  brand:       { fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: 14, color: '#f9fafb' },
  headerSep:   { color: '#374151' },
  headerPage:  { fontSize: 13, color: '#6b7280' },
  retakeBtn:   { fontSize: 12, fontWeight: 600, color: '#6b7280', background: 'transparent', border: '1.5px solid #1f2937', borderRadius: 8, padding: '6px 14px', cursor: 'pointer' },

  // Content
  main:        { maxWidth: 860, margin: '0 auto', padding: '32px 24px 60px' },
  twoCol:      { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginTop: 20 },
  footer:      { fontSize: 11, color: '#374151', textAlign: 'center', marginTop: 32, lineHeight: 1.6 },

  // Loading screen
  loadWrap:    { maxWidth: 480, margin: '0 auto', padding: '80px 24px', textAlign: 'center' },
  loadIconWrap:{ position: 'relative', width: 72, height: 72, margin: '0 auto 28px' },
  loadIcon:    { fontSize: 40, position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  loadRing:    { position: 'absolute', inset: 0, borderRadius: '50%', border: '3px solid transparent', borderTopColor: '#06b6d4', animation: 'spin 1s linear infinite' },
  loadTitle:   { fontFamily: 'Syne, sans-serif', fontSize: 22, fontWeight: 700, color: '#f9fafb', margin: '0 0 12px' },
  loadSub:     { fontSize: 14, color: '#6b7280', margin: '0 0 28px', lineHeight: 1.7 },
  loadBarWrap: { height: 4, background: '#1f2937', borderRadius: 4, overflow: 'hidden', marginBottom: 28 },
  loadBar:     { height: '100%', background: 'linear-gradient(90deg, #06b6d4, #6366f1)', borderRadius: 4, transition: 'width 0.5s ease' },
  loadSteps:   { display: 'flex', flexDirection: 'column', gap: 10, textAlign: 'left', maxWidth: 280, margin: '0 auto' },
  loadStep:    { display: 'flex', alignItems: 'center', gap: 10 },
  loadStepDot: { width: 18, height: 18, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: '#000', fontWeight: 700, flexShrink: 0 },
  loadStepText:{ fontSize: 13 },

  // Error screen
  errorWrap:   { maxWidth: 420, margin: '0 auto', padding: '80px 24px', textAlign: 'center' },
  errorIcon:   { fontSize: 48, display: 'block', marginBottom: 20 },
  errorTitle:  { fontFamily: 'Syne, sans-serif', fontSize: 22, fontWeight: 700, color: '#f9fafb', margin: '0 0 12px' },
  errorMsg:    { fontSize: 14, color: '#6b7280', lineHeight: 1.7, margin: '0 0 28px' },
  retryBtn:    { padding: '12px 28px', background: 'linear-gradient(135deg, #06b6d4, #6366f1)', color: '#fff', border: 'none', borderRadius: 11, fontSize: 14, fontWeight: 600, cursor: 'pointer', transition: 'opacity 0.2s' },
};

const ANIM_STYLES = `
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  @media (max-width: 680px) {
    .results-two-col {
      grid-template-columns: 1fr !important;
    }
  }
`;








