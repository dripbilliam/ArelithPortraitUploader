-- NWN portrait resource names behave like resrefs (16 chars total including size suffix).
-- Keep prefix at <= 15 so `<prefix><H|L|M|S|T>` stays valid.

update public.images
set filename_prefix = lower(substr(md5(id::text), 1, 15))
where filename_prefix is null
  or filename_prefix !~ '^[a-z0-9_]{1,15}$';

alter table public.images
drop constraint if exists images_filename_prefix_format_chk;

alter table public.images
add constraint images_filename_prefix_format_chk
check (filename_prefix ~ '^[a-z0-9_]{1,15}$');