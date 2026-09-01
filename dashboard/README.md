# Dashboard — MT5 SaaS Frontend

Live deployment: [https://mt5dashboardui.vercel.app](https://mt5dashboardui.vercel.app)

Vercel team `lucre1`, project `mt5_dashboard_ui`. The GitHub `main` branch is
connected to production, and the repository-level `vercel.json` publishes this
directory as the static output.

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

Pushes to `main` deploy to production through Vercel's Git integration. Verify
the deployment reaches `READY` and check at least one changed live asset before
calling a release complete.
