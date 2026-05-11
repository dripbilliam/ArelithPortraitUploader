create table if not exists public.api_upload_limits (
  id text primary key,
  images_per_ip_limit integer not null check (images_per_ip_limit > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.api_upload_limits (id, images_per_ip_limit)
values ('global', 50)
on conflict (id) do update
set
  images_per_ip_limit = excluded.images_per_ip_limit,
  updated_at = now();

alter table public.api_upload_limits enable row level security;

drop trigger if exists api_upload_limits_set_updated_at on public.api_upload_limits;
create trigger api_upload_limits_set_updated_at
before update on public.api_upload_limits
for each row
execute function public.set_updated_at();
