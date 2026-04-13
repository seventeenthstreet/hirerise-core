-- ============================================================
-- PATCH 31 | FILE 1 OF 5
-- supabase/migrations/20260413_001_baseline_schema.sql
-- LIVE-SAFE DELTA BASELINE
-- Phase 0 reconciled against 180-table production schema
-- ============================================================

create extension if not exists "pgcrypto";
create extension if not exists "uuid-ossp";

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================
-- user_profiles — ALTER ONLY
-- live id type = TEXT (critical Phase 0 finding)
-- ============================================================
alter table public.user_profiles
  add column if not exists firebase_uid text,
  add column if not exists tier text not null default 'free',
  add column if not exists subscription_status text,
  add column if not exists ai_credits_remaining integer not null default 0,
  add column if not exists credit_deduction_log jsonb not null default '[]',
  add column if not exists full_name text,
  add column if not exists seniority text,
  add column if not exists location text;

update public.user_profiles
set firebase_uid = uid
where firebase_uid is null
  and uid is not null;

update public.user_profiles
set tier = case
  when coalesce(is_premium, false) = true then 'pro'
  when plan is not null then plan
  else 'free'
end
where tier is null
   or tier = 'free';

create or replace function public.sync_firebase_uid_bridge()
returns trigger
language plpgsql
as $$
begin
  if new.firebase_uid is not null then
    new.uid = new.firebase_uid;
  elsif new.uid is not null then
    new.firebase_uid = new.uid;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_up_sync_firebase_uid
on public.user_profiles;

create trigger trg_up_sync_firebase_uid
  before insert or update on public.user_profiles
  for each row
  execute function public.sync_firebase_uid_bridge();

drop trigger if exists trg_user_profiles_updated_at
on public.user_profiles;

create trigger trg_user_profiles_updated_at
  before update on public.user_profiles
  for each row
  execute function public.set_updated_at();

-- ============================================================
-- onboarding_progress — ALTER ONLY
-- preserve UNIQUE(user_id)
-- ============================================================
alter table public.onboarding_progress
  add column if not exists status text not null default 'pending',
  add column if not exists payload jsonb,
  add column if not exists education jsonb;

update public.onboarding_progress
set status = case
  when completed = true then 'completed'
  else 'pending'
end
where status is null;

drop trigger if exists trg_onboarding_progress_updated_at
on public.onboarding_progress;

create trigger trg_onboarding_progress_updated_at
  before update on public.onboarding_progress
  for each row
  execute function public.set_updated_at();

-- ============================================================
-- subscriptions — ALTER ONLY
-- ============================================================
alter table public.subscriptions
  add column if not exists auto_renew boolean not null default false;

drop trigger if exists trg_subscriptions_updated_at
on public.subscriptions;

create trigger trg_subscriptions_updated_at
  before update on public.subscriptions
  for each row
  execute function public.set_updated_at();

-- ============================================================
-- cover_letters — fully missing table
-- IMPORTANT: user_id TEXT
-- ============================================================
create table if not exists public.cover_letters (
  id            uuid primary key default gen_random_uuid(),
  user_id       text not null references public.user_profiles(id) on delete cascade,
  resume_id     uuid references public.resumes(id) on delete set null,
  job_title     text,
  company       text,
  content       text,
  tone          text,
  status        text not null default 'draft',
  metadata      jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

drop trigger if exists trg_cover_letters_updated_at
on public.cover_letters;

create trigger trg_cover_letters_updated_at
  before update on public.cover_letters
  for each row
  execute function public.set_updated_at();