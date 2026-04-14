'use client';

import React, { memo } from 'react';
import {
  usePersonalizedRecommendations,
  usePersonalizationProfile,
  getSignalStrengthLabel,
  getSignalStrengthColor,
} from '@/hooks/usePersonalization';
import { cn } from '@/utils/cn';

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────

type RecommendationItem = {
  id?: string;
  title?: string;
  match_score?: number;
  reason?: string;
  missing_skills?: string[];
  rank?: number;
};

// ─────────────────────────────────────────────────────────────
// SIGNAL BADGE
// ─────────────────────────────────────────────────────────────

export function PersonalizationSignalBadge({
  showLabel = false,
}: {
  showLabel?: boolean;
}) {
  const { data: profile } = usePersonalizationProfile();

  const strength = profile?.signal_strength ?? 0;
  const label = getSignalStrengthLabel(strength);
  const color = getSignalStrengthColor(strength);

  return (
    <div
      className={cn(
        'flex items-center gap-2 px-2.5 py-1 rounded-full text-xs font-medium',
        color
      )}
    >
      <span className="h-2 w-2 rounded-full bg-current" />
      {showLabel && <span>{label}</span>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// RECOMMENDATION CARD (MEMOIZED)
// ─────────────────────────────────────────────────────────────

const RecommendationCard = memo(function RecommendationCard({
  item,
}: {
  item: RecommendationItem;
}) {
  return (
    <div className="rounded-xl border border-surface-100 bg-white p-4 shadow-sm hover:shadow-md transition">
      <div className="flex items-start justify-between mb-2">
        <div>
          <h4 className="text-sm font-semibold text-surface-900">
            {item.title ?? 'Unknown Role'}
          </h4>
          <p className="text-xs text-surface-500">
            Match: {item.match_score ?? 0}%
          </p>
        </div>

        <span className="text-xs font-medium text-violet-600">
          #{item.rank ?? '-'}
        </span>
      </div>

      {item.reason && (
        <p className="text-xs text-surface-600 leading-relaxed mb-2">
          {item.reason}
        </p>
      )}

      {item.missing_skills?.length ? (
        <div className="flex flex-wrap gap-1 mt-2">
          {item.missing_skills.slice(0, 3).map((skill) => (
            <span
              key={skill}
              className="text-[10px] bg-red-50 text-red-600 px-2 py-0.5 rounded-full"
            >
              {skill}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
});

// ─────────────────────────────────────────────────────────────
// SKELETON LOADER
// ─────────────────────────────────────────────────────────────

function SkeletonCard() {
  return (
    <div className="h-20 rounded-xl bg-surface-100 animate-pulse" />
  );
}

// ─────────────────────────────────────────────────────────────
// MAIN PANEL
// ─────────────────────────────────────────────────────────────

export function PersonalizedRecommendationsPanel({
  topN = 10,
}: {
  topN?: number;
}) {
  const { data, isLoading, error } = usePersonalizedRecommendations(topN);

  // ── Loading State ───────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  // ── Error State ─────────────────────────────────────────────
  if (error) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-center">
        <p className="text-sm text-red-600">
          Failed to load recommendations
        </p>
        <p className="text-xs text-red-400 mt-1">
          Please try again later.
        </p>
      </div>
    );
  }

  // ── Normalize Data ──────────────────────────────────────────
  const items: RecommendationItem[] =
    data?.recommendations?.map((item: any, index: number) => ({
      id: item.id ?? `rec-${index}`,
      title: item.title,
      match_score: Number(item.match_score ?? 0),
      reason: item.reason,
      missing_skills: item.missing_skills ?? [],
      rank: index + 1,
    })) || [];

  // ── Empty State ─────────────────────────────────────────────
  if (!items.length) {
    return (
      <div className="rounded-xl border border-dashed border-surface-200 p-5 text-center">
        <p className="text-sm text-surface-500">
          No personalized recommendations yet.
        </p>
        <p className="text-xs text-surface-400 mt-1">
          Interact more with jobs and skills to unlock recommendations.
        </p>
      </div>
    );
  }

  // ── Render ──────────────────────────────────────────────────
  return (
    <div className="space-y-3">
      {items.map((item) => (
        <RecommendationCard key={item.id} item={item} />
      ))}
    </div>
  );
}