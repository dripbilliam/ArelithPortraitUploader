# ArelithPortraitUploader

Supabase-first backend scaffold for image ingest, conversion tracking, and bulk download URL generation.

## Frontend app (simple uploader)

A minimal Next.js app now lives in `web/`.

It supports:

- Email/password auth with Supabase Auth
- Uploading JPG/JPEG files through `create-upload-url`
- Optional user-provided filename prefix (legacy parity)
- Converting JPG/JPEG -> 5 NWN TGA files client-side in browser
- Finalizing conversion row through `finalize-client-conversion`
- Automatic dedupe of identical TGA sets via SHA-256 hash
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

Filename prefix notes:

- Allowed characters: `a-z`, `0-9`, `_`
- Max length: `15` characters (so files like `<prefix>H.tga` stay NWN-compatible)

## What is included

- Local Supabase config (`supabase/config.toml`)
- Initial SQL migration (`supabase/migrations/202605100001_initial_schema.sql`)
- Edge function to issue signed upload URL (`create-upload-url`)
- Edge function to finalize client-side conversion (`finalize-client-conversion`)
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
supabase functions deploy finalize-client-conversion
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
   - `filenamePrefix` (optional)
2. Function stores a final `filename_prefix` (user provided or generated) and inserts an `images` row.
3. Browser converts JPG/JPEG to NWN TGA variants (`H`, `L`, `M`, `S`, `T`) and uploads them to `portraits-converted`.
4. Client calls `finalize-client-conversion` with `imageId` and base path to mark row `ready`, delete the transient original path, and dedupe against existing converted sets.
5. Client calls `request-bulk-download` to generate and download one ZIP containing all users' stored images named as `<filename_prefix><size>.tga`.
6. Old ZIP exports are cleaned up automatically after signed-link expiry plus a small buffer.

## Anti-abuse safety net

`request-bulk-download` is open to authenticated users, with built-in safeguards:

- Per-user rate limit: 3 export requests per 15 minutes
- Per-export cap: up to 1000 files scanned
- Per-export input size cap: 200 MiB total before zipping
- Audit logging in `public.bulk_download_audit`

## Missing piece you still need

Current conversion runs in the browser for low infra cost and easy scaling.
For heavier production load or stricter trust boundaries, migrate conversion to a backend worker.

Recommended options:

- Supabase Edge Function using a compatible image library
- External worker (Cloud Run, Fly.io, or VPS) consuming queued jobs

## Suggested next commit

```powershell
git add .
git commit -m "Bootstrap Supabase schema and edge functions"
git push origin main
```
