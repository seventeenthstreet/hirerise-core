-- ============================================================
-- PATCH 31 | FILE 5 OF 5
-- Delta-safe indexes + RPC compatibility
-- Phase 0 reconciled
-- ============================================================

-- ============================================================
-- INDEXES
-- ============================================================
create index if not exists idx_onboarding_progress_user_id
  on public.onboarding_progress (user_id);

create index if not exists idx_onboarding_progress_user_status
  on public.onboarding_progress (user_id, status);

create index if not exists idx_resumes_user_id
  on public.resumes (user_id);

create index if not exists idx_ai_usage_logs_user_created
  on public.ai_usage_logs (user_id, created_at desc);

create index if not exists idx_career_health_index_user_created
  on public.career_health_index (user_id, created_at desc);

create index if not exists idx_role_skills_role_id
  on public.role_skills (role_id);

create index if not exists idx_role_transitions_from_role_id
  on public.role_transitions (from_role_id);

create index if not exists idx_subscriptions_subscription_id
  on public.subscriptions (subscription_id);

create index if not exists idx_user_profiles_firebase_uid
  on public.user_profiles (firebase_uid)
  where firebase_uid is not null;

create index if not exists idx_career_predictions_user_id
  on public.career_predictions (user_id, created_at desc);

create index if not exists idx_career_simulations_user_id
  on public.career_simulations (user_id, created_at desc);

create index if not exists idx_user_skills_user_id
  on public.user_skills (user_id);

-- ============================================================
-- RPC: seed_user_and_profile
-- TEXT identity + JSONB return preserved
-- ============================================================
create or replace function public.seed_user_and_profile(
  p_user_id text,
  p_email text,
  p_display_name text default null,
  p_photo_url text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_created_profile boolean := false;
begin
  if not exists (
    select 1 from public.user_profiles where id = p_user_id
  ) then
    insert into public.user_profiles (
      id,
      email,
      display_name,
      photo_url,
      tier,
      ai_credits_remaining,
      created_at,
      updated_at
    )
    values (
      p_user_id,
      p_email,
      p_display_name,
      p_photo_url,
      'free',
      0,
      now(),
      now()
    );
    v_created_profile := true;
  end if;

  return jsonb_build_object(
    'created_user', false,
    'created_profile', v_created_profile
  );
end;
$$;

-- ============================================================
-- RPC: sync_user_display_fields
-- TEXT identity + JSONB return preserved
-- ============================================================
create or replace function public.sync_user_display_fields(
  p_user_id text,
  p_display_name text default null,
  p_photo_url text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  update public.user_profiles
     set display_name = coalesce(p_display_name, display_name),
         photo_url = coalesce(p_photo_url, photo_url),
         updated_at = now()
   where id = p_user_id;

  get diagnostics v_rows = row_count;

  return jsonb_build_object(
    'users_updated', false,
    'profile_updated', v_rows > 0
  );
end;
$$;

-- IMPORTANT:
-- DO NOT replace activate_subscription_tx
-- Existing live RPC is more mature and Phase 0 approved