-- ============================================================
-- PATCH 31 | FILE 3 OF 5
-- supabase/migrations/20260413_003_roles_skills.sql
-- Delta-safe Roles, Skills & Transitions
-- Phase 0 reconciled
-- ============================================================

-- ============================================================
-- roles — ALTER ONLY
-- ============================================================
alter table public.roles
  add column if not exists slug text;

comment on table public.roles is
  'Canonical role catalogue consumed by matching engines.';

drop trigger if exists trg_roles_updated_at
on public.roles;

create trigger trg_roles_updated_at
  before update on public.roles
  for each row
  execute function public.set_updated_at();

-- ============================================================
-- skills
-- create only if truly missing
-- ============================================================
create table if not exists public.skills (
  id            uuid primary key default gen_random_uuid(),
  name          text unique not null,
  category      text,
  aliases       text[],
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

-- ============================================================
-- role_skills
-- existing live table healthy — ALTER only if needed
-- ============================================================
alter table public.role_skills
  add column if not exists importance text not null default 'required',
  add column if not exists weight numeric(4,2) default 1.0;

comment on table public.role_skills is
  'Role-to-skill mapping consumed by jobMatchingEngine.';

-- ============================================================
-- role_transitions — ALTER ONLY
-- ============================================================
alter table public.role_transitions
  add column if not exists required_skills uuid[],
  add column if not exists typical_path jsonb;

comment on table public.role_transitions is
  'Directed role transition graph for careerOpportunityEngine.';

-- ============================================================
-- user_skills — fully missing
-- IMPORTANT: user_id TEXT
-- ============================================================
create table if not exists public.user_skills (
  id              uuid primary key default gen_random_uuid(),
  user_id         text not null references public.user_profiles(id) on delete cascade,
  skill_id        uuid not null references public.skills(id) on delete cascade,
  proficiency     text default 'intermediate',
  years_exp       numeric(4,1),
  source          text,
  verified        boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint user_skills_user_skill_uq unique (user_id, skill_id)
);

drop trigger if exists trg_user_skills_updated_at
on public.user_skills;

create trigger trg_user_skills_updated_at
  before update on public.user_skills
  for each row
  execute function public.set_updated_at();