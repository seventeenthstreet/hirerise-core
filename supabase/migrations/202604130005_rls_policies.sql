-- ============================================================
-- PATCH 31 | FILE 4 OF 5
-- Delta-safe RLS policies
-- TEXT identity + Firebase bridge safe
-- ============================================================

create or replace function public.uid_from_firebase(p_firebase_uid text)
returns text
language sql
security definer
stable
as $$
  select id
    from public.user_profiles
   where firebase_uid = p_firebase_uid
   limit 1;
$$;

-- ============================================================
-- user_profiles
-- ============================================================
alter table public.user_profiles enable row level security;

drop policy if exists "user_profiles: own read" on public.user_profiles;
create policy "user_profiles: own read"
  on public.user_profiles
  for select
  using ((auth.uid())::text = id);

drop policy if exists "user_profiles: own update" on public.user_profiles;
create policy "user_profiles: own update"
  on public.user_profiles
  for update
  using ((auth.uid())::text = id)
  with check ((auth.uid())::text = id);

-- ============================================================
-- onboarding_progress
-- ============================================================
alter table public.onboarding_progress enable row level security;

drop policy if exists "onboarding_progress: own read" on public.onboarding_progress;
create policy "onboarding_progress: own read"
  on public.onboarding_progress
  for select
  using ((auth.uid())::text = user_id);

drop policy if exists "onboarding_progress: own insert" on public.onboarding_progress;
create policy "onboarding_progress: own insert"
  on public.onboarding_progress
  for insert
  with check ((auth.uid())::text = user_id);

drop policy if exists "onboarding_progress: own update" on public.onboarding_progress;
create policy "onboarding_progress: own update"
  on public.onboarding_progress
  for update
  using ((auth.uid())::text = user_id)
  with check ((auth.uid())::text = user_id);

-- ============================================================
-- resumes
-- ============================================================
alter table public.resumes enable row level security;

drop policy if exists "resumes: own read" on public.resumes;
create policy "resumes: own read"
  on public.resumes
  for select
  using ((auth.uid())::text = user_id);

-- ============================================================
-- cover_letters
-- ============================================================
alter table public.cover_letters enable row level security;

drop policy if exists "cover_letters: own read" on public.cover_letters;
create policy "cover_letters: own read"
  on public.cover_letters
  for select
  using ((auth.uid())::text = user_id);

-- ============================================================
-- subscriptions
-- ============================================================
alter table public.subscriptions enable row level security;

drop policy if exists "subscriptions: own read" on public.subscriptions;
create policy "subscriptions: own read"
  on public.subscriptions
  for select
  using ((auth.uid())::text = user_id);

-- ============================================================
-- career_health_index
-- ============================================================
alter table public.career_health_index enable row level security;

drop policy if exists "career_health_index: own read" on public.career_health_index;
create policy "career_health_index: own read"
  on public.career_health_index
  for select
  using ((auth.uid())::text = user_id);

-- ============================================================
-- ai_usage_logs
-- ============================================================
alter table public.ai_usage_logs enable row level security;

drop policy if exists "ai_usage_logs: own read" on public.ai_usage_logs;
create policy "ai_usage_logs: own read"
  on public.ai_usage_logs
  for select
  using ((auth.uid())::text = user_id);

-- ============================================================
-- career_predictions
-- ============================================================
alter table public.career_predictions enable row level security;

drop policy if exists "career_predictions: own read" on public.career_predictions;
create policy "career_predictions: own read"
  on public.career_predictions
  for select
  using ((auth.uid())::text = user_id);

-- ============================================================
-- career_simulations
-- ============================================================
alter table public.career_simulations enable row level security;

drop policy if exists "career_simulations: own read" on public.career_simulations;
create policy "career_simulations: own read"
  on public.career_simulations
  for select
  using ((auth.uid())::text = user_id);

-- ============================================================
-- user_skills
-- ============================================================
alter table public.user_skills enable row level security;

drop policy if exists "user_skills: own read" on public.user_skills;
create policy "user_skills: own read"
  on public.user_skills
  for select
  using ((auth.uid())::text = user_id);