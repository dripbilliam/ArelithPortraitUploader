create extension if not exists "pgcrypto";

create table if not exists public.images (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  original_path text not null,
  converted_path text,
  source_mime text not null,
  target_format text not null check (target_format in ('png', 'jpg', 'webp')),
  status text not null default 'uploaded' check (status in ('uploaded', 'processing', 'ready', 'failed')),
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists images_user_id_created_at_idx
  on public.images (user_id, created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists images_set_updated_at on public.images;
create trigger images_set_updated_at
before update on public.images
for each row
execute function public.set_updated_at();

alter table public.images enable row level security;

create policy "Users can view own images"
on public.images
for select
to authenticated
using (auth.uid() = user_id);

create policy "Users can insert own images"
on public.images
for insert
to authenticated
with check (auth.uid() = user_id);

create policy "Users can update own images"
on public.images
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "Users can delete own images"
on public.images
for delete
to authenticated
using (auth.uid() = user_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'portraits-original',
  'portraits-original',
  false,
  26214400,
  array['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/tiff']
)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'portraits-converted',
  'portraits-converted',
  false,
  26214400,
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do nothing;

create policy "Users can upload own originals"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'portraits-original'
  and split_part(name, '/', 1) = auth.uid()::text
);

create policy "Users can read own originals"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'portraits-original'
  and split_part(name, '/', 1) = auth.uid()::text
);

create policy "Users can read own converted"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'portraits-converted'
  and split_part(name, '/', 1) = auth.uid()::text
);
