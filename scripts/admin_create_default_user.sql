-- Admin script: create (or reuse) a default user in auth.users.
-- Run in Supabase SQL editor.
--
-- Why this exists:
-- - Reconcile/admin scripts may need a stable owner user_id for recovered rows.
-- - This script is idempotent: if email already exists, it reuses that user.

create extension if not exists pgcrypto;

do $$
declare
  DEFAULT_EMAIL text := lower('reconcile-default@local.invalid'); -- TODO: change if you want
  DEFAULT_DISPLAY_NAME text := 'Reconcile Default User';
  DEFAULT_USER_ID uuid := null; -- optional: set explicit UUID; leave null to auto-generate

  v_existing_id uuid;
  v_final_id uuid;
begin
  -- Prefer existing user by email.
  select u.id
  into v_existing_id
  from auth.users u
  where lower(u.email) = DEFAULT_EMAIL
  limit 1;

  if v_existing_id is not null then
    v_final_id := v_existing_id;

    -- Keep metadata sane if this user already existed.
    update auth.users
    set
      raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb)
        || jsonb_build_object('display_name', DEFAULT_DISPLAY_NAME),
      raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
        || jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email')),
      updated_at = now()
    where id = v_final_id;

    raise notice 'Default user already exists. user_id=% email=%', v_final_id, DEFAULT_EMAIL;
  else
    v_final_id := coalesce(DEFAULT_USER_ID, gen_random_uuid());

    insert into auth.users (
      instance_id,
      id,
      aud,
      role,
      email,
      encrypted_password,
      email_confirmed_at,
      confirmation_sent_at,
      raw_app_meta_data,
      raw_user_meta_data,
      created_at,
      updated_at,
      is_sso_user,
      is_anonymous
    )
    values (
      '00000000-0000-0000-0000-000000000000',
      v_final_id,
      'authenticated',
      'authenticated',
      DEFAULT_EMAIL,
      crypt(gen_random_uuid()::text, gen_salt('bf')),
      now(),
      now(),
      jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email')),
      jsonb_build_object('display_name', DEFAULT_DISPLAY_NAME),
      now(),
      now(),
      false,
      false
    );

    -- Intentionally skipping auth.identities insert.
    -- Supabase auth schema fields can differ by version (for example provider_id constraints),
    -- and this service user only needs a stable auth.users.id for admin ownership fallback.

    raise notice 'Default user created. user_id=% email=%', v_final_id, DEFAULT_EMAIL;
  end if;
end $$;

-- Quick lookup after run:
-- select id, email, raw_user_meta_data->>'display_name' as display_name, created_at
-- from auth.users
-- where lower(email) = lower('reconcile-default@local.invalid');
