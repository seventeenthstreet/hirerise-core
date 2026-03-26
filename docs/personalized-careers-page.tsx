'use client';

/**
 * app/(dashboard)/personalized-careers/page.tsx
 *
 * Dedicated "For You" page showing AI-personalized career recommendations.
 *
 * Route: /personalized-careers
 *
 * Displays:
 *   - PersonalizationSignalBadge (current signal level)
 *   - PersonalizationProfileSummary (what the engine has learned)
 *   - PersonalizedRecommendationsPanel (ranked career list)
 *
 * Sidebar entry to add in Sidebar.tsx:
 *   { href: '/personalized-careers', label: 'For You', icon: <SparklesIcon /> }
 */

import { useState } from 'react';
import {
  usePersonalizedRecommendations,
  usePersonalizationProfile,
  useTriggerProfileUpdate,
  getSignalStrengthLabel,
  getSignalStrengthColor,
  type CareerInterest,
  type PreferredRole,
  type PreferredSkill,
} from '@/hooks/usePersonalization';
import {
  PersonalizedRecommendationsPanel,
  PersonalizationSignalBadge,
} from '@/components/personalization/PersonalizedRecommendations';
import { cn } from '@/utils/cn';

// ─── Profile summary card ─────────────────────────────────────────────────────

function ProfileSummaryCard() {
  const { data: profile, isLoading } = usePersonalizationProfile();
  const { mutate: triggerUpdate, isPending } = useTriggerProfileUpdate();

  if (isLoading) {
    return (
      <div className="rounded-2xl border border-surface-100 bg-white shadow-sm p-5">
        <div className="space-y-2">
          <div className="h-4 w-40 rounded bg-surface-100 animate-pulse" />
          <div className="h-3 w-56 rounded bg-surface-100 animate-pulse" />
        </div>
      </div>
    );
  }

  if (!profile || !profile.has_profile) {
    return (
      <div className="rounded-2xl border border-dashed border-violet-200 bg-violet-50 p-5">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-100 shrink-0">
            <svg className="h-5 w-5 text-violet-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-semibold text-violet-700 mb-1">Your profile is building</p>
            <p className="text-xs text-violet-500 leading-relaxed">
              Interact with job cards, explore skills, and click on opportunities.
              The more you use HireRise, the more personalized your recommendations become.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-surface-100 bg-white shadow-sm overflow-hidden">
      <div className="h-1 bg-gradient-to-r from-violet-400 via-indigo-400 to-blue-400" />
      <div className="p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-sm font-bold text-surface-900">What We Know About You</h3>
            <p className="text-[10px] text-surface-400 uppercase tracking-wide mt-0.5">
              Derived from {profile.total_events} interactions
            </p>
          </div>
          <button
            onClick={() => triggerUpdate()}
            disabled={isPending}
            className="text-[11px] text-violet-600 hover:underline disabled:opacity-40"
          >
            {isPending ? 'Updating…' : 'Refresh ↻'}
          </button>
        </div>

        {/* Completeness bar */}
        <div className="mb-4">
          <div className="flex items-center justify-between text-[11px] mb-1">
            <span className="text-surface-500">Profile completeness</span>
            <span className="font-semibold text-violet-700">{profile.profile_completeness}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-surface-100 overflow-hidden">
            <div
              className="h-full rounded-full bg-gradient-to-r from-violet-400 to-indigo-400"
              style={{ width: `${profile.profile_completeness}%` }}
            />
          </div>
        </div>

        {/* Three signal groups */}
        <div className="grid grid-cols-3 gap-3">
          {/* Preferred roles */}
          <div className="space-y-1.5">
            <p className="text-[10px] font-semibold text-surface-500 uppercase tracking-wide">
              Top Roles
            </p>
            {profile.preferred_roles.slice(0, 3).map((r: PreferredRole) => (
              <div key={r.name} className="flex items-center gap-1.5">
                <div
                  className="h-1.5 rounded-full bg-violet-400"
                  style={{ width: `${Math.round(r.score * 40)}px` }}
                />
                <span className="text-[11px] text-surface-700 truncate">{r.name}</span>
              </div>
            ))}
            {profile.preferred_roles.length === 0 && (
              <p className="text-[11px] text-surface-400 italic">Not yet detected</p>
            )}
          </div>

          {/* Preferred skills */}
          <div className="space-y-1.5">
            <p className="text-[10px] font-semibold text-surface-500 uppercase tracking-wide">
              Top Skills
            </p>
            {profile.preferred_skills.slice(0, 3).map((s: PreferredSkill) => (
              <div key={s.name} className="flex items-center gap-1.5">
                <div
                  className="h-1.5 rounded-full bg-indigo-400"
                  style={{ width: `${Math.round(s.score * 40)}px` }}
                />
                <span className="text-[11px] text-surface-700 truncate">{s.name}</span>
              </div>
            ))}
            {profile.preferred_skills.length === 0 && (
              <p className="text-[11px] text-surface-400 italic">Not yet detected</p>
            )}
          </div>

          {/* Career interests */}
          <div className="space-y-1.5">
            <p className="text-[10px] font-semibold text-surface-500 uppercase tracking-wide">
              Industries
            </p>
            {profile.career_interests.slice(0, 3).map((i: CareerInterest) => (
              <div key={i.industry} className="flex items-center gap-1.5">
                <div
                  className="h-1.5 rounded-full bg-teal-400"
                  style={{ width: `${Math.round(i.score * 40)}px` }}
                />
                <span className="text-[11px] text-surface-700 truncate">{i.industry}</span>
              </div>
            ))}
            {profile.career_interests.length === 0 && (
              <p className="text-[11px] text-surface-400 italic">Not yet detected</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function PersonalizedCareersPage() {
  const { data } = usePersonalizedRecommendations(10);

  return (
    <div className="max-w-2xl mx-auto py-6 px-4 space-y-5">
      {/* Page header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-surface-900">For You</h1>
          <p className="text-sm text-surface-500 mt-0.5">
            AI-personalized career recommendations based on your activity
          </p>
        </div>
        {data && (
          <PersonalizationSignalBadge showLabel />
        )}
      </div>

      {/* What the engine learned */}
      <ProfileSummaryCard />

      {/* Personalized career recommendations */}
      <PersonalizedRecommendationsPanel topN={10} />
    </div>
  );
}
