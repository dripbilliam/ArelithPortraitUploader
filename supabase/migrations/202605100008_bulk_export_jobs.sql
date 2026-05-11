create table if not exists public.bulk_export_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'processing', 'ready', 'failed')),
  file_count integer not null default 0,
  skipped_count integer not null default 0,
  zip_path text,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bulk_export_jobs_user_created_idx
  on public.bulk_export_jobs (user_id, created_at desc);

create index if not exists bulk_export_jobs_status_created_idx
  on public.bulk_export_jobs (status, created_at desc);

drop trigger if exists bulk_export_jobs_set_updated_at on public.bulk_export_jobs;
create trigger bulk_export_jobs_set_updated_at
before update on public.bulk_export_jobs
for each row
execute function public.set_updated_at();

alter table public.bulk_export_jobs enable row level security;

create policy "Users can view own export jobs"
on public.bulk_export_jobs
for select
to authenticated
using (auth.uid() = user_id);

create policy "Users can create own export jobs"
on public.bulk_export_jobs
for insert
to authenticated
with check (auth.uid() = user_id);