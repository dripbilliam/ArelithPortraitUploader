create table if not exists public.api_access_bans (
  id uuid primary key default gen_random_uuid(),
  ip text,
  email text,
  user_id uuid references auth.users(id) on delete cascade,
  scope text not null default 'any' check (scope in ('any', 'upload', 'download')),
  reason text,
  active boolean not null default true,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint api_access_bans_target_chk check (
    ip is not null or email is not null or user_id is not null
  )
);

create index if not exists api_access_bans_active_ip_idx
  on public.api_access_bans (active, ip)
  where ip is not null;

create index if not exists api_access_bans_active_email_idx
  on public.api_access_bans (active, email)
  where email is not null;

create index if not exists api_access_bans_active_user_idx
  on public.api_access_bans (active, user_id)
  where user_id is not null;

alter table public.api_access_bans enable row level security;

drop trigger if exists api_access_bans_set_updated_at on public.api_access_bans;
create trigger api_access_bans_set_updated_at
before update on public.api_access_bans
for each row
execute function public.set_updated_at();

alter table public.images
add column if not exists uploader_ip text;

alter table public.bulk_download_audit
alter column user_id drop not null;

alter table public.bulk_download_audit
add column if not exists requester_key text;

create index if not exists bulk_download_audit_requester_created_idx
  on public.bulk_download_audit (requester_key, created_at desc);

alter table public.bulk_export_jobs
alter column user_id drop not null;

alter table public.bulk_export_jobs
add column if not exists requester_key text;

alter table public.bulk_export_jobs
add column if not exists requester_ip text;

alter table public.bulk_export_jobs
add column if not exists access_token uuid not null default gen_random_uuid();

update public.bulk_export_jobs
set requester_key = coalesce(requester_key, concat('user:', user_id::text))
where requester_key is null and user_id is not null;

update public.bulk_export_jobs
set requester_key = coalesce(requester_key, concat('ip:', coalesce(requester_ip, 'unknown')))
where requester_key is null;

alter table public.bulk_export_jobs
alter column requester_key set not null;

create index if not exists bulk_export_jobs_requester_created_idx
  on public.bulk_export_jobs (requester_key, created_at desc);

create index if not exists bulk_export_jobs_access_token_idx
  on public.bulk_export_jobs (id, access_token);
