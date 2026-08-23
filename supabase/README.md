# Lucre Supabase project

This directory is the deployable source of truth for project
`qxlfnscmrhwfcpattqxa` (`mt5-trading-platform`). It was initialized and linked
with Supabase CLI 2.111.0.

## Contents

- `config.toml` records local-stack settings and every function's live
  `verify_jwt` behavior.
- `functions/` contains the production-synchronized Edge Function bundles and
  pending local functions. Shared helpers are kept per function because the deployed
  bundles contain intentionally different historical helper revisions.
- `migrations/` contains the synchronized remote history plus new local SQL
  migrations, retaining the original version identifiers.

## Realtime terminal wake-up channel

`terminal-realtime-config` validates the opaque terminal key and returns the
public Realtime connection key plus that terminal's random topic. Broadcasts
contain no command or account data; they only tell the EA to reconcile through
the API-key-authenticated `ea-sync` endpoint. This avoids per-terminal Auth
users, refresh traffic and Auth MAU consumption.

The older `backend/` directory is retained as an audit snapshot. Make future
backend changes here, not under `backend/functions` or
`backend/schema/migrations`.

## Safe workflow

```sh
./scripts/supabase-release.sh check
./scripts/supabase-release.sh plan
```

`check` verifies the linked project and displays remote migration/function
state. `plan` performs a migration dry run and does not change production.

Production deployment is deliberately gated:

```sh
SUPABASE_DEPLOY_CONFIRM=qxlfnscmrhwfcpattqxa \
  ./scripts/supabase-release.sh apply
```

The apply path pushes pending migrations first, then deploys all functions
through the Supabase API. Do not use `--prune` until retired functions have
been reviewed explicitly.

## Local development

`supabase start`, `supabase db reset`, schema dumps, and local function serving
require Docker Desktop or another Docker-compatible runtime. Remote migration
planning and API-based function deployment do not require Docker.

Supabase credentials are stored by the CLI outside this repository. Never
commit access tokens, database passwords, service-role keys, or `.env` files.
