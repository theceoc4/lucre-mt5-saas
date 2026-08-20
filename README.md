# Lucre — MT5 SaaS Trading Platform

Single version-controlled home for all three components of the Lucre trading
system. Previously each component only existed in its live/deployed form
(Supabase, Vercel, and a local MetaTrader install) with no shared repo — this
repo consolidates the current state of all three as of **2026-08-20**.

## Components

| Component | Location in repo | Live location | Version |
|---|---|---|---|
| Backend (Supabase) | [`backend/`](./backend) | [qxlfnscmrhwfcpattqxa.supabase.co](https://qxlfnscmrhwfcpattqxa.supabase.co) | v1.0.18 |
| Dashboard (frontend) | [`dashboard/`](./dashboard) | [mt5dashboardui.vercel.app](https://mt5dashboardui.vercel.app) | v1.0.15 |
| EA (MetaTrader 5) | [`ea/`](./ea) | Runs on MT5 terminal / VPS | v1.0.18 (single-file) |

## Important caveats

- **Backend is a current-state snapshot, not full history.** The 12 Edge
  Functions are the actual deployed source. The database schema
  (`backend/schema/`) was captured via live introspection — Supabase does not
  retain the original SQL text of the 41 migrations that built this schema
  over time, only their version/name metadata. See
  [`backend/schema/README.md`](./backend/schema/README.md) for details and
  the plan to avoid this gap going forward.
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
backend/
  functions/         12 Supabase Edge Functions (current deployed source)
  schema/            Database schema snapshot (tables, RLS, functions, extensions, migration list)
dashboard/
  *.html/js/css       Static frontend served from Vercel
  assets/             Favicons/icons
ea/
  mt5_ea/LucreHubEA.mq5   Single-file consolidated EA source
  CHANGELOG.md
```

## Going forward

- Every new Supabase migration should be saved into
  `backend/schema/migrations/<version>_<name>.sql` in this repo at the time
  it's applied, so future snapshots don't lose SQL history the way this one
  did.
- Dashboard and EA changes should be committed here before/alongside
  deploying to Vercel / recompiling in MetaEditor, so this repo stays the
  source of truth.
