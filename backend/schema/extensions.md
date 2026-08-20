# Installed Postgres Extensions

Introspected live via the Supabase management API (`list_extensions`). Only extensions
with a non-null `installed_version` are actually active on the project; the rest are
available in the Postgres distribution but not enabled. See `tables.md` for the
schema-snapshot caveat.

| Extension | Schema | Installed Version | Purpose |
|---|---|---|---|
| pgcrypto | extensions | 1.3 | Cryptographic functions |
| pg_stat_statements | extensions | 1.11 | Tracks planning/execution stats of SQL statements |
| pg_net | public | 0.20.4 | Async HTTP client (used for calendar ingestion / outbound webhooks) |
| supabase_vault | vault | 0.3.1 | Supabase Vault (encrypted secrets) |
| uuid-ossp | extensions | 1.1 | UUID generation |
| pg_cron | pg_catalog | 1.6.4 | Job scheduler (drives `throttle_sweep`, `sweep_stuck_commands`, calendar ingestion, etc.) |
| plpgsql | pg_catalog | 1.0 | Procedural language for all `public` schema functions |

All other extensions listed by the Postgres distribution (postgis, pgvector, pgjwt,
pgmq, pgroonga, etc.) are available but **not installed/enabled** on this project.
