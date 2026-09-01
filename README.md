# Lucre — MT5 SaaS Trading Platform

Single version-controlled home for all three components of the Lucre trading
system. Previously each component only existed in its live/deployed form
(Supabase, Vercel, and a local MetaTrader install) with no shared repo — this
repo consolidates the current state of all three. The Supabase deployment tree
was synchronized from production on **2026-08-21**.

## Components

| Component | Location in repo | Live location | Version |
|---|---|---|---|
| Backend (Supabase) | [`supabase/`](./supabase) | [qxlfnscmrhwfcpattqxa.supabase.co](https://qxlfnscmrhwfcpattqxa.supabase.co) | reliable strategy state mutation v1.0.40 |
| Dashboard (frontend) | [`dashboard/`](./dashboard) | [mt5dashboardui.vercel.app](https://mt5dashboardui.vercel.app) | v1.0.42 |
| EA (MetaTrader 5) | [`ea/`](./ea) | Runs on MT5 terminal / VPS | v1.0.35 (single-file) |

## Important caveats

- **`supabase/` is the backend deployment source of truth.** It contains all
  production-synchronized Edge Functions and migrations plus pending local
  releases. `backend/` remains only as the earlier audit snapshot.
- **EA ships uncompiled.** No MQL5 compiler is available outside MetaEditor,
  so `ea/mt5_ea/LucreHubEA.mq5` must be compiled locally in MetaEditor before
  use. As of v1.0.18 it's a single consolidated file (no external `.mqh`
  includes) specifically so it works on MT5 VPS hosting, which doesn't sync
  auxiliary files.
- **No secrets are committed.** Only the public Supabase anon key (safe by
  design — RLS enforces access control) appears in this repo. Service-role
  keys, DB passwords, and Vercel/Supabase project secrets are not stored
  here.

## Repo layout

```
supabase/
  functions/         Deployable Supabase Edge Functions
  migrations/        Version-aligned SQL migrations
  config.toml        Local project and function authentication configuration
backend/              Earlier read-only backend audit snapshot
dashboard/
  *.html/js/css       Static frontend served from Vercel
  assets/             Favicons/icons
ea/
  mt5_ea/LucreHubEA.mq5   Single-file consolidated EA source
  CHANGELOG.md
```

## Going forward

- Create every new migration with `supabase migration new <name>` and deploy
  through `scripts/supabase-release.sh`, keeping code and migration history in
  one release.
- Dashboard and EA changes should be committed here before/alongside
  deploying to Vercel / recompiling in MetaEditor, so this repo stays the
  source of truth.
