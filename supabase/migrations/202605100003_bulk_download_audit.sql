create table if not exists public.bulk_download_audit (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  requester_ip text,
  status text not null check (status in ('ok', 'rate_limited', 'failed')),
  file_count integer not null default 0,
  skipped_count integer not null default 0,
  zip_path text,
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists bulk_download_audit_user_created_idx
  on public.bulk_download_audit (user_id, created_at desc);

create index if not exists bulk_download_audit_created_idx
  on public.bulk_download_audit (created_at desc);

alter table public.bulk_download_audit enable row level security;
