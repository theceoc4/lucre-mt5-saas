# Dashboard — MT5 SaaS Frontend

Live deployment: [https://mt5dashboardui.vercel.app](https://mt5dashboardui.vercel.app)

Vercel team `lucre1`, project `mt5_dashboard_ui`. Confirmed version at time of
snapshot: **v1.0.15**.

Static frontend (no build step) that talks directly to the Supabase project
described in `../backend/README.md` using the public anon key embedded in
`supabase-client.js`.

## Files

- `index.html` — main page markup
- `app.js`, `main.js` — application logic
- `edge-functions.js` — thin client wrappers around the backend Edge Functions
- `supabase-client.js` — Supabase JS client init (anon key, project URL)
- `base.css`, `style.css` — styling
- `assets/` — favicons and touch icons
- `CHANGELOG.md` — version history

## Deploying changes

This is currently deployed directly to Vercel from local files (no CI/CD
pipeline connected to this repo yet). Pushing here does not automatically
redeploy — treat this as the version-controlled source of truth to pull from
before making changes, and push back here after deploying.
