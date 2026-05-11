# Web Frontend

This is the Next.js frontend for ArelithPortraitUploader.

## Local development

```bash
copy .env.local.example .env.local
npm install
npm run dev
```

Required values in `.env.local`:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` (Supabase publishable key)

## GitHub Pages deployment

This app is configured for static export (`output: "export"`) and includes a workflow at:

- `.github/workflows/deploy-pages.yml`

Workflow behavior:

- Builds from `web/`
- Exports static files to `web/out`
- Deploys to GitHub Pages on `main` branch pushes

GitHub repo setup required:

1. In GitHub: `Settings -> Pages`, set `Build and deployment` to `GitHub Actions`.
2. In GitHub: `Settings -> Secrets and variables -> Actions`, add repository secrets:
	- `NEXT_PUBLIC_SUPABASE_URL`
	- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

After pushing to `main`, GitHub Actions will publish the site to Pages.
