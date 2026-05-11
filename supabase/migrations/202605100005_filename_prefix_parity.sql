alter table public.images
add column if not exists filename_prefix text;

update public.images
set filename_prefix = lower(replace(id::text, '-', ''))
where filename_prefix is null or btrim(filename_prefix) = '';

alter table public.images
alter column filename_prefix set not null;

alter table public.images
drop constraint if exists images_filename_prefix_format_chk;

alter table public.images
add constraint images_filename_prefix_format_chk
check (filename_prefix ~ '^[a-z0-9_]{1,64}$');

create unique index if not exists images_filename_prefix_key
on public.images (filename_prefix);