-- Reconcile public.images against portraits-converted storage objects.
--
-- What this script does:
-- 1) Deletes image rows that reference converted paths missing required TGA files in storage.
-- 2) Finds storage portrait sets with no matching image row and:
--    - logs them to a debug table
--    - creates recovered image rows owned by a default user
--
-- HOW TO USE:
-- 1) Replace the DEFAULT_USER_ID constant below with a real auth.users.id value.
-- 2) Run in Supabase SQL editor.
--
-- Notes:
-- - This script only reconciles converted TGA sets in bucket 'portraits-converted'.
-- - It expects NWN suffix files: _H.tga, _L.tga, _M.tga, _S.tga, _T.tga.

create extension if not exists pgcrypto;

create table if not exists public.image_storage_reconcile_debug (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  event_type text not null, -- 'db_missing_storage' | 'storage_missing_db'
  action_taken text not null,
  image_id uuid,
  converted_base text,
  storage_path text,
  owner_user_id uuid,
  details jsonb not null default '{}'::jsonb
);

create index if not exists image_storage_reconcile_debug_created_idx
  on public.image_storage_reconcile_debug (created_at desc);

create index if not exists image_storage_reconcile_debug_event_idx
  on public.image_storage_reconcile_debug (event_type, created_at desc);

do $$
declare
  DEFAULT_USER_ID uuid := '00000000-0000-0000-0000-000000000000'; -- TODO: set this
begin
  -- Validate default user exists.
  if not exists (
    select 1
    from auth.users u
    where u.id = DEFAULT_USER_ID
  ) then
    raise exception 'DEFAULT_USER_ID % does not exist in auth.users. Update the script before running.', DEFAULT_USER_ID;
  end if;

  -- Collect converted-path rows in DB and storage base coverage.
  create temporary table _db_image_candidates on commit drop as
  select
    i.id as image_id,
    i.user_id,
    i.converted_path,
    i.filename_prefix
  from public.images i
  where i.target_format = 'tga'
    and i.converted_path is not null
    and btrim(i.converted_path) <> '';

  create temporary table _storage_file_rows on commit drop as
  select
    o.name as storage_path,
    regexp_replace(o.name, '_[HLMST]\\.tga$', '') as converted_base,
    upper(regexp_replace(o.name, '^.*_([HLMST])\\.tga$', '\\1')) as suffix
  from storage.objects o
  where o.bucket_id = 'portraits-converted'
    and o.name ~ '^[^\\s].*_[HLMST]\\.tga$';

  create temporary table _storage_base_sets on commit drop as
  select
    sfr.converted_base,
    count(distinct sfr.suffix) as suffix_count,
    array_agg(distinct sfr.storage_path order by sfr.storage_path) as paths
  from _storage_file_rows sfr
  group by sfr.converted_base;

  -- 1) DB rows missing storage set -> log + delete row.
  create temporary table _db_missing_storage on commit drop as
  select
    d.image_id,
    d.user_id,
    d.converted_path,
    coalesce(s.suffix_count, 0) as suffix_count
  from _db_image_candidates d
  left join _storage_base_sets s
    on s.converted_base = d.converted_path
  where coalesce(s.suffix_count, 0) < 5;

  insert into public.image_storage_reconcile_debug (
    event_type,
    action_taken,
    image_id,
    converted_base,
    owner_user_id,
    details
  )
  select
    'db_missing_storage',
    'deleted_image_row',
    m.image_id,
    m.converted_path,
    m.user_id,
    jsonb_build_object('found_suffix_count', m.suffix_count)
  from _db_missing_storage m;

  delete from public.images i
  using _db_missing_storage m
  where i.id = m.image_id;

  -- 2) Storage sets missing DB row (require complete 5-file set) -> log + recover row under default user.
  create temporary table _storage_missing_db on commit drop as
  select
    s.converted_base,
    s.paths
  from _storage_base_sets s
  left join _db_image_candidates d
    on d.converted_path = s.converted_base
  where s.suffix_count = 5
    and d.image_id is null;

  insert into public.image_storage_reconcile_debug (
    event_type,
    action_taken,
    converted_base,
    storage_path,
    owner_user_id,
    details
  )
  select
    'storage_missing_db',
    'inserted_recovered_image_row',
    smd.converted_base,
    p.path,
    DEFAULT_USER_ID,
    jsonb_build_object('paths', smd.paths)
  from _storage_missing_db smd
  cross join lateral unnest(smd.paths) as p(path);

  insert into public.images (
    user_id,
    original_path,
    converted_path,
    source_mime,
    target_format,
    status,
    error_message,
    filename_prefix,
    uploader_ip
  )
  select
    DEFAULT_USER_ID,
    'recovered/' || smd.converted_base,
    smd.converted_base,
    'image/jpeg',
    'tga',
    'ready',
    'Recovered from orphaned storage files by reconcile script',
    substr(md5(gen_random_uuid()::text), 1, 15),
    'reconcile-script'
  from _storage_missing_db smd;

  raise notice 'Reconcile complete. Deleted DB rows: %, Recovered storage sets: %',
    (select count(*) from _db_missing_storage),
    (select count(*) from _storage_missing_db);
end $$;

-- Optional quick summary after run:
-- select event_type, action_taken, count(*)
-- from public.image_storage_reconcile_debug
-- where created_at > now() - interval '10 minutes'
-- group by event_type, action_taken
-- order by event_type, action_taken;
