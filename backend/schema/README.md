# Schema Snapshot

This folder is a **current-state introspection snapshot** of the Supabase
Postgres database backing project `qxlfnscmrhwfcpattqxa`, taken on 2026-08-20.

It is **not** a replay of the 41 migrations that were applied to reach this
state — Supabase's migration history API (`list_migrations`) only exposes
each migration's version timestamp and name, not its original SQL body, so
that history could not be reconstructed after the fact.

| File | Contents |
|---|---|
| `tables.md` | All 19 tables in `public`, with columns, types, defaults, and primary keys |
| `rls_policies.md` | All 24 Row-Level Security policies, grouped by table |
| `functions_and_triggers.sql` | Full `CREATE OR REPLACE FUNCTION` definitions for all 17 functions/triggers |
| `extensions.md` | The 7 Postgres extensions actually enabled on the project |
| `migrations.md` | Metadata-only list of the 41 migrations applied (version + name, no SQL) |

## Going forward

To avoid this gap recurring, every future migration applied via the Supabase
MCP `apply_migration` tool (or the Supabase CLI) should also be committed to
a `migrations/<version>_<name>.sql` file in this repo *at the same time* it's
applied, so the actual SQL text is preserved in version control from now on.
