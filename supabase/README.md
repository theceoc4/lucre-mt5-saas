# Lucre Supabase project

This directory is the deployable source of truth for project
`qxlfnscmrhwfcpattqxa` (`mt5-trading-platform`). It was initialized and linked
with Supabase CLI 2.111.0.

## Contents

- `config.toml` records local-stack settings and every function's live
  `verify_jwt` behavior.
- `functions/` contains the 12 live Edge Function bundles downloaded from the
  linked project. Shared helpers are kept per function because the deployed
  bundles contain intentionally different historical helper revisions.
- `migrations/` contains all 43 SQL migrations fetched from the remote
  migration history, including their original version identifiers.

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
