# Working on this project from multiple tools

This repo is the single source of truth for Lucre (backend, dashboard, EA),
meant to be worked on from more than one AI tool or environment (Perplexity
Computer, Claude, ChatGPT, Cursor, your own terminal, etc.). Follow these
rules from *any* tool so nothing gets overwritten or lost.

## Every session, in order

1. **Pull before you touch anything.**
   `git pull origin main` — always start from the latest committed state,
   even if you (or another tool) just pushed five minutes ago.
2. **Make your changes.**
3. **Commit with a real message** — what changed and why, not just "update".
   `git commit -m "ea: fix pip-distance rounding on JPY pairs"`
4. **If you deployed something live** (Supabase migration, Vercel deploy,
   new EA build), do the deploy and the commit together, and say so in the
   commit message, e.g. `"backend: apply migration 038_x, deployed to
   qxlfnscmrhwfcpattqxa"`. The repo should never silently drift out of sync
   with what's actually live.
5. **Push.** `git push origin main`

Small/safe changes can go straight to `main`. For anything riskier —
schema changes, EA order-management logic, anything you're not sure about —
work on a short branch (`git checkout -b fix/thing`), verify it, then merge
into `main` so `main` always reflects something that's known to work.

## Supabase migrations specifically

Whenever a new migration is applied to project `qxlfnscmrhwfcpattqxa` (via
Supabase MCP, the Supabase CLI, or the dashboard SQL editor), save its SQL
to `backend/schema/migrations/<version>_<name>.sql` in this repo *at the
same time*. This is the one piece of history that was missing when the repo
was first created (see `backend/schema/README.md`) — don't let the gap
reopen.

## Credentials

Each tool/environment authenticates to GitHub with its own credentials (its
own `gh`/git login or token) — there's nothing shared to set up beyond each
tool having push access to `theceoc4/lucre-mt5-saas`. No secrets live in
this repo; Supabase service-role keys and Vercel env vars stay in their
respective dashboards only.

## Keeping a record

Whichever tool you're working in, summarize what you changed and why back
in that tool's own conversation thread (so there's a human-readable trail
alongside the git history). The commit history and `CHANGELOG.md` files
(`dashboard/CHANGELOG.md`, `ea/CHANGELOG.md`) are the durable, tool-agnostic
record — update them when you bump a version.
