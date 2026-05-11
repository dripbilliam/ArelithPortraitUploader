-- Compare per-user counts from storage vs public.images.
--
-- Storage side:
-- - Reads storage.objects from bucket 'portraits-converted'.
-- - Uses first path segment as user folder ID (expected auth.users.id UUID).
-- - Counts raw TGA files and inferred portrait sets per user.
--
-- DB side:
-- - Counts rows in public.images per user_id.
--
-- Output:
-- - One row per user_id found in either storage or DB.
-- - Shows DB counts, storage counts, and diffs.
--
-- Usage:
-- 1) Run in Supabase SQL Editor.

with
params as (
  select
    'portraits-converted'::text as target_bucket,
    5::int as tga_variants_per_upload
),
storage_tga_files as (
  select
    split_part(o.name, '/', 1) as folder_user_id,
    o.name as storage_path,
    regexp_replace(o.name, '_[HLMST]\\.tga$', '') as storage_base,
    upper(regexp_replace(o.name, '^.*_([HLMST])\\.tga$', '\\1')) as suffix
  from storage.objects o
  cross join params p
  where o.bucket_id = p.target_bucket
    and o.name ~ '^[0-9a-fA-F-]{36}/.+_[HLMST]\\.tga$'
),
storage_sets as (
  select
    f.folder_user_id,
    f.storage_base,
    count(distinct f.suffix)::int as suffix_count
  from storage_tga_files f
  group by f.folder_user_id, f.storage_base
),
storage_by_user as (
  select
    s.folder_user_id as user_id_text,
    count(*)::int as storage_portrait_sets_any,
    count(*) filter (where s.suffix_count = 5)::int as storage_portrait_sets_complete,
    sum(s.suffix_count)::int as storage_tga_file_count
  from storage_sets s
  group by s.folder_user_id
),
db_by_user as (
  select
    i.user_id::text as user_id_text,
    count(*)::int as db_image_rows,
    count(*) filter (where i.status = 'ready')::int as db_ready_rows
  from public.images i
  group by i.user_id::text
),
combined as (
  select
    coalesce(s.user_id_text, d.user_id_text) as user_id_text,
    coalesce(d.db_image_rows, 0) as db_image_rows,
    coalesce(d.db_ready_rows, 0) as db_ready_rows,
    coalesce(s.storage_portrait_sets_any, 0) as storage_portrait_sets_any,
    coalesce(s.storage_portrait_sets_complete, 0) as storage_portrait_sets_complete,
    coalesce(s.storage_tga_file_count, 0) as storage_tga_file_count
  from storage_by_user s
  full outer join db_by_user d
    on d.user_id_text = s.user_id_text
),
limit_row as (
  select
    coalesce((
      select aul.images_per_ip_limit
      from public.api_upload_limits aul
      where aul.id = 'global'
      limit 1
    ), 50) as images_per_ip_limit
  from params p
),
projection as (
  select
    c.user_id_text,
    c.db_image_rows,
    c.db_ready_rows,
    c.storage_portrait_sets_any,
    c.storage_portrait_sets_complete,
    c.storage_tga_file_count,
    (c.storage_tga_file_count / p.tga_variants_per_upload)::int as storage_estimated_upload_rows,
    p.tga_variants_per_upload,
    c.storage_tga_file_count as storage_total_images_estimate,
    c.db_image_rows * p.tga_variants_per_upload as db_total_images_estimate,
    l.images_per_ip_limit
  from combined c
  cross join params p
  cross join limit_row l
)
select
  p.user_id_text as user_id_folder,
  p.db_image_rows,
  p.db_ready_rows,
  p.storage_portrait_sets_any,
  p.storage_portrait_sets_complete,
  p.storage_estimated_upload_rows,
  p.storage_tga_file_count,
  p.db_total_images_estimate,
  (p.storage_tga_file_count - p.db_total_images_estimate) as storage_minus_db_image_count,
  p.images_per_ip_limit,
  (p.storage_tga_file_count <= p.images_per_ip_limit) as would_allow_based_on_storage
from projection p
order by p.storage_tga_file_count desc, p.db_image_rows desc, p.user_id_text;
