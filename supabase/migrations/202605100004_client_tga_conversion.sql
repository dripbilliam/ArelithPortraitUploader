alter table public.images
  drop constraint if exists images_target_format_check;

alter table public.images
  add constraint images_target_format_check
  check (target_format in ('png', 'jpg', 'webp', 'tga'));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'portraits-converted',
  'portraits-converted',
  false,
  52428800,
  array['image/x-tga', 'application/octet-stream']
)
on conflict (id) do nothing;

update storage.buckets
set
  file_size_limit = 52428800,
  allowed_mime_types = array['image/x-tga', 'application/octet-stream']
where id = 'portraits-converted';

drop policy if exists "Users can upload own converted" on storage.objects;

create policy "Users can upload own converted"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'portraits-converted'
  and split_part(name, '/', 1) = auth.uid()::text
);
