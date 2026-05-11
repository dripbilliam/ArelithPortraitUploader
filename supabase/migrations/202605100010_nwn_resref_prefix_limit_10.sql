-- Tighten NWN portrait prefix length to <= 10 chars.
-- Resulting filenames become <= 11 chars with size suffix (e.g. <prefix>H).

update public.images
set filename_prefix = lower(substr(md5(id::text), 1, 10))
where filename_prefix is null
  or filename_prefix !~ '^[a-z0-9_]{1,10}$';

alter table public.images
drop constraint if exists images_filename_prefix_format_chk;

alter table public.images
add constraint images_filename_prefix_format_chk
check (filename_prefix ~ '^[a-z0-9_]{1,10}$');
