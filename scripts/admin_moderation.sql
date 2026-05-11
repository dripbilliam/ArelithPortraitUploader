-- Admin moderation toolkit for ArelithPortraitUploader
-- Run these in Supabase SQL editor as needed.

-- =====================================================
-- BAN / UNBAN
-- =====================================================

-- Ban by IP for all API usage (upload + download)
-- replace 203.0.113.10 with target IP
insert into public.api_access_bans (ip, scope, reason, active)
values ('203.0.113.10', 'any', 'manual moderation ban', true);

-- Ban by email for upload only
-- replace user@example.com
insert into public.api_access_bans (email, scope, reason, active)
values (lower('user@example.com'), 'upload', 'upload abuse', true);

-- Ban by user_id for download only
-- replace UUID
insert into public.api_access_bans (user_id, scope, reason, active)
values ('00000000-0000-0000-0000-000000000000', 'download', 'download abuse', true);

-- Temporary ban by IP (example: 7 days)
insert into public.api_access_bans (ip, scope, reason, active, expires_at)
values (
  '203.0.113.10',
  'any',
  'temporary abuse cooldown',
  true,
  now() + interval '7 days'
);

-- Unban by IP
update public.api_access_bans
set active = false, updated_at = now()
where ip = '203.0.113.10' and active = true;

-- Unban by email
update public.api_access_bans
set active = false, updated_at = now()
where email = lower('user@example.com') and active = true;

-- Unban by user_id
update public.api_access_bans
set active = false, updated_at = now()
where user_id = '00000000-0000-0000-0000-000000000000' and active = true;

-- View active bans
select id, ip, email, user_id, scope, reason, expires_at, created_at
from public.api_access_bans
where active = true
order by created_at desc;

-- =====================================================
-- PURGE IMAGES BY USER
-- =====================================================

-- 1) preview rows to purge for a user
select id, user_id, uploader_ip, converted_path, created_at
from public.images
where user_id = '00000000-0000-0000-0000-000000000000'
order by created_at desc;

-- 2) delete image rows (storage object cleanup happens in app flow; run storage cleanup separately if needed)
delete from public.images
where user_id = '00000000-0000-0000-0000-000000000000';

-- =====================================================
-- PURGE IMAGES BY UPLOADER IP
-- =====================================================

-- 1) preview rows to purge for uploader IP
select id, user_id, uploader_ip, converted_path, created_at
from public.images
where uploader_ip = '203.0.113.10'
order by created_at desc;

-- 2) delete image rows by uploader IP
delete from public.images
where uploader_ip = '203.0.113.10';

-- =====================================================
-- PURGE JOB/AUDIT ARTIFACTS BY REQUESTER IP
-- =====================================================

-- preview audit/job rows
select * from public.bulk_download_audit where requester_ip = '203.0.113.10' order by created_at desc;
select * from public.bulk_export_jobs where requester_ip = '203.0.113.10' order by created_at desc;

-- delete audit/job rows for requester IP
delete from public.bulk_download_audit where requester_ip = '203.0.113.10';
delete from public.bulk_export_jobs where requester_ip = '203.0.113.10';
