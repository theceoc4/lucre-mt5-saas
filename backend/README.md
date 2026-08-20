# Backend — Supabase Edge Functions & Database

Live project: `qxlfnscmrhwfcpattqxa` — [https://qxlfnscmrhwfcpattqxa.supabase.co](https://qxlfnscmrhwfcpattqxa.supabase.co)

Confirmed version at time of snapshot: **v1.0.18** (ea-sync v6, self-healing reconciler).

## Structure

- `functions/` — all 12 deployed Edge Functions, current source, one folder per function:
  - `provision-terminal-key/` (v1)
  - `ea-sync/` (v6)
  - `signal-action/` (v4)
  - `manual-order/` (v3)
  - `position-action/` (v3)
  - `calendar-sync/` (v1)
  - `report-symbols/` (v3)
  - `ea-stream/` (v1)
  - `request-symbol-rescan/` (v1)
  - `bind-symbol/` (v2)
  - `report-bars/` (v2)
  - `strategy-signal-engine/` (v1)

  Each function folder has a `_meta.json` with its slug, deployed version,
  `verify_jwt` setting, and entrypoint path. Functions that use shared helper
  modules keep an `_shared/` sibling folder (e.g. `canonical-symbols.ts`,
  `symbol-resolver.ts`, `throttle-gate.ts`, `auth.ts`); functions with no
  shared dependencies are a flat `index.ts`.

- `schema/` — full database schema **snapshot** (tables, RLS policies,
  functions/triggers, extensions, migration history metadata). See
  `schema/README.md` for the important caveat about what is and isn't
  recoverable from Supabase's introspection API.

## Public identifiers (safe to commit)

- Project URL: `https://qxlfnscmrhwfcpattqxa.supabase.co`
- Anon key: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF4bGZuc2Ntcmh3ZmNwYXR0cXhhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY5MTI5NjYsImV4cCI6MjEwMjQ4ODk2Nn0.7nmSfQlFKyuYtej2i9TcQQVIjkeauqPA4iTGessQHWA`

No service-role keys, database passwords, or other secrets are stored in
this repo. Those live only in Supabase project settings / Vercel environment
variables.
