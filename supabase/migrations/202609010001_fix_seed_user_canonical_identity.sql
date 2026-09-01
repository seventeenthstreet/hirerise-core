-- ============================================================
-- HireRise Core
-- Fix canonical user identity bootstrap
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
  v_user_id uuid;
  v_created_user boolean := false;
  v_created_profile boolean := false;
begin
  -- Canonical Auth UUID
  begin
    v_user_id := p_user_id::uuid;
  exception
    when invalid_text_representation then
      raise exception 'INVALID_USER_ID';
  end;

  if nullif(trim(p_email), '') is null then
    raise exception 'EMAIL_REQUIRED';
  end if;

  -- Ensure canonical application user exists.
  -- Never modify role, tier, credits, or other existing state.
  if not exists (
    select 1
      from public.users
     where id = v_user_id
        or uid = p_user_id
  ) then

    insert into public.users (
      id,
      email,
      display_name,
      uid
    )
    values (
      v_user_id,
      trim(p_email),
      p_display_name,
      p_user_id
    );

    v_created_user := true;

  else

    update public.users
       set email = coalesce(email, trim(p_email)),
           display_name = coalesce(display_name, p_display_name),
           uid = coalesce(uid, p_user_id),
           updated_at = now()
     where id = v_user_id
        or uid = p_user_id;

  end if;

  -- Ensure user profile exists.
  if not exists (
    select 1
      from public.user_profiles
     where id = p_user_id
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
      trim(p_email),
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
    'created_user', v_created_user,
    'created_profile', v_created_profile
  );
end;
$$;
