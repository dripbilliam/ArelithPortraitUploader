# ArelithPortraitUploader

Supabase-first backend scaffold for image ingest, conversion tracking, and bulk download URL generation.

## Frontend app (simple uploader)

A minimal Next.js app now lives in `web/`.

It supports:

- Email/password auth with Supabase Auth
- Uploading image files through `create-upload-url`
- Triggering conversion through `process-image`
- Writing upload records to `public.images`
- One-click download of all stored images across all users as a ZIP

### Run frontend locally

```powershell
cd web
npm install
copy .env.local.example .env.local
```

Set `NEXT_PUBLIC_SUPABASE_ANON_KEY` in `web/.env.local`, then run:

```powershell
npm run dev
```

Open `http://localhost:3000`.

### Deploy frontend to GitHub Pages

Static deployment is configured with:

- `web/next.config.ts` (`output: "export"`)
- `.github/workflows/deploy-pages.yml`

Setup steps in GitHub:

1. Go to `Settings -> Pages` and select `Build and deployment: GitHub Actions`.
2. Go to `Settings -> Secrets and variables -> Actions` and add:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
3. Push to `main` branch.

The workflow will build `web/`, export static files, and publish to GitHub Pages.

### Note on Data API exposure

Supabase changed defaults for Data API exposure on new projects. If the upload list fails to load from `public.images`, expose the table to API roles (`anon`, `authenticated`) and keep RLS enabled.

## What is included

- Local Supabase config (`supabase/config.toml`)
- Initial SQL migration (`supabase/migrations/202605100001_initial_schema.sql`)
- Edge function to issue signed upload URL (`create-upload-url`)
- Edge function to convert uploaded files (`process-image`)
- Edge function to issue signed bulk download URLs (`request-bulk-download`)

## Prerequisites

- Git
- Supabase CLI
- A Supabase project (free tier is fine to start)

Install CLI (Windows):

```powershell
winget install Supabase.CLI
```

## Quick start (local)

```powershell
# From repo root
supabase start
supabase db reset
supabase functions serve --no-verify-jwt
```

## Link to hosted Supabase project

```powershell
supabase login
supabase link --project-ref <your-project-ref>
supabase db push
supabase functions deploy create-upload-url
supabase functions deploy process-image
supabase functions deploy request-bulk-download
```

## Required secrets for Edge Functions

Set these in Supabase dashboard or via CLI:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

`SUPABASE_SERVICE_ROLE_KEY` is a reserved runtime variable in hosted Edge Functions and is not set manually with `supabase secrets set`.

CLI example:

```powershell
supabase secrets set SUPABASE_URL=https://<your-project-ref>.supabase.co
supabase secrets set SUPABASE_ANON_KEY=<anon-key>
```

## API flow

1. Authenticated client calls `create-upload-url` with:
   - `filename`
   - `sourceMime`
   - `targetFormat` (`png` | `jpg` | `webp`)
2. Function returns signed upload URL for `portraits-original` bucket and inserts an `images` row.
3. Client calls `process-image` with `imageId`, converts image, and writes output to `portraits-converted`.
4. Function updates `images.status='ready'` and sets `converted_path`.
5. Admin client calls `request-bulk-download` to generate and download one ZIP containing all users' images.

## Anti-abuse safety net

`request-bulk-download` is open to authenticated users, with built-in safeguards:

- Per-user rate limit: 3 export requests per 15 minutes
- Per-export cap: up to 1000 files scanned
- Per-export input size cap: 200 MiB total before zipping
- Audit logging in `public.bulk_download_audit`

## Missing piece you still need

Current conversion runs one image per function call and is good for starting quickly.
For heavier production load, migrate conversion to an async queue/worker.

Recommended options:

- Supabase Edge Function using a compatible image library
- External worker (Cloud Run, Fly.io, or VPS) consuming queued jobs

## Suggested next commit

```powershell
git add .
git commit -m "Bootstrap Supabase schema and edge functions"
git push origin main
```
