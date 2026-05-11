create table if not exists public.upload_files (
  id uuid primary key default gen_random_uuid(),
  image_id uuid not null unique references public.images(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  chosen_prefix text,
  final_prefix text not null,
  final_file_name text not null,
  converted_path_base text not null,
  uploader_ip text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists upload_files_user_created_idx
  on public.upload_files (user_id, created_at desc);

create index if not exists upload_files_image_id_idx
  on public.upload_files (image_id);

alter table public.upload_files enable row level security;

drop trigger if exists upload_files_set_updated_at on public.upload_files;
create trigger upload_files_set_updated_at
before update on public.upload_files
for each row
execute function public.set_updated_at();

drop policy if exists "Users can view own upload files" on public.upload_files;
create policy "Users can view own upload files"
on public.upload_files
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "Users can insert own upload files" on public.upload_files;
create policy "Users can insert own upload files"
on public.upload_files
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "Users can update own upload files" on public.upload_files;
create policy "Users can update own upload files"
on public.upload_files
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "Users can delete own upload files" on public.upload_files;
create policy "Users can delete own upload files"
on public.upload_files
for delete
to authenticated
using (auth.uid() = user_id);

insert into public.upload_files (
  image_id,
  user_id,
  chosen_prefix,
  final_prefix,
  final_file_name,
  converted_path_base,
  uploader_ip,
  created_at,
  updated_at
)
select
  i.id,
  i.user_id,
  null,
  i.filename_prefix,
  i.filename_prefix || 'H.tga',
  coalesce(i.converted_path, i.user_id::text || '/' || i.id::text),
  i.uploader_ip,
  i.created_at,
  i.updated_at
from public.images i
where i.filename_prefix is not null
on conflict (image_id) do update
set
  user_id = excluded.user_id,
  final_prefix = excluded.final_prefix,
  final_file_name = excluded.final_file_name,
  converted_path_base = excluded.converted_path_base,
  uploader_ip = excluded.uploader_ip,
  updated_at = now();
