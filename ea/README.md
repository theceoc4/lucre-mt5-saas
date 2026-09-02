# LucreHubEA — v1.0.40 (single-file build)

## What changed in this build

Every prior release shipped as `LucreHubEA.mq5` plus five sibling include
files that had to be copied separately into `MQL5/Include`:

- `EASync.mqh` — core execution client (polls `ea-sync`, reports
  account/positions, executes queued commands)
- `CalendarSync.mqh` — pushes MT5's native Economic Calendar to
  `calendar-sync`
- `EAStream.mqh` — optional persistent WebSocket for near-instant command
  pickup
- `SymbolMap.mqh` — reports the broker's full symbol list to
  `report-symbols`
- `PriceReporter.mqh` — reports broker-native closed bars for all enabled
  symbols across M1, M5, M15, M30, H1, H4, D1, and W1 to `report-bars`

That works fine on a terminal you control directly, but **MetaTrader VPS
hosting does not reliably sync sibling `.mq5`/`.mqh` source files** — it
generally only carries over the compiled `.ex5` for the EA you attach, not
its `#include` dependencies. Attaching a fresh install on a VPS with the
multi-file layout could fail to compile (or silently run stale/missing
includes) because `EASync.mqh` and friends never made it onto the VPS's
`MQL5/Include` folder.

**This build inlines all five modules directly into `LucreHubEA.mq5`.**
MQL5's `#include` is plain text substitution — the compiled `.ex5` from this
single file is byte-for-byte equivalent to compiling the old five-file
layout before the v1.0.20 safety controls described below. Each module's
original header/doc comments are preserved in place, wrapped in
`BEGIN inlined module: X.mqh` / `END inlined module: X.mqh` banners, purely
so the file stays navigable (search for `BEGIN inlined module` to jump
between sections).

## Install (one file now)

1. Copy **only** `mt5_ea/LucreHubEA.mq5` into `MQL5/Experts/` on the
   terminal (local **or** VPS-hosted).
2. Open it in MetaEditor and compile (F7). No `.mqh` files to copy —
   there are no `#include` dependencies left to satisfy.
3. Attach the compiled EA to one chart per terminal, same as before.
4. Fill in the Inputs tab: paste your `TerminalApiKey` (from the
   dashboard's "Provision API Key" action), leave `SupabaseProjectUrl` as
   the default `https://qxlfnscmrhwfcpattqxa.supabase.co`.
5. **Tools > Options > Expert Advisors > "Allow WebRequest for listed
   URL"** — add `https://qxlfnscmrhwfcpattqxa.supabase.co` (still required;
   unchanged from prior releases).
6. Check the Experts/Journal tab for `LucreHubEA: initialized` followed by
   `EASync: initialized` to confirm the first poll succeeds.

If you're moving an existing local install to a VPS: delete any old
`EASync.mqh` / `CalendarSync.mqh` / `EAStream.mqh` / `SymbolMap.mqh` /
`PriceReporter.mqh` files from `MQL5/Include` on the VPS first (they're no
longer needed and won't be referenced), then follow the steps above with
just the one `.mq5` file.

## Safety behavior added in v1.0.20

- Open-order idempotency uses a compact 23-character `lh:` trade comment,
  avoiding broker truncation of the prior UUID-based comment. Existing legacy
  comments remain recognized during an EA upgrade.
- The EA independently rejects an open if its volume is outside the broker's
  min/max/step, above `0.10` lots, or if the account already has five open
  positions.
- Every open must resolve to a protective stop-loss in the correct direction.
  The EA uses MT5's `OrderCalcProfit` to reject an order whose estimated loss
  at that stop is above `500` in the account currency.

These are conservative compiled safeguards, separate from the dashboard and
database limits. A command rejected by one appears in the dashboard as failed
with a specific reason (for example `hard_stop_loss_required`). Review these
constants in `mt5_ea/LucreHubEA.mq5` before changing risk policy.

## Transport and market data in v1.0.22

- Commands wake the EA through a random terminal-scoped Supabase Realtime
  Broadcast channel. The event contains no trading data; `ea_commands` remains
  authoritative and the wake-up only causes an immediate secure reconciliation.
- The EA polls every 60 seconds while Realtime is healthy and every 10 seconds
  while it is unavailable, instead of issuing an HTTP request every two
  seconds continuously.
- The terminal API key retrieves the public Realtime connection key and its
  unguessable topic once per EA session. No per-terminal Supabase Auth users or
  token-refresh traffic are required.
- The price reporter scans locally every five seconds but makes a network
  request only when a selected timeframe has a newly closed candle.
- M1, M5, M15, M30, H1, H4, D1 and W1 are supported. Each series backfills up
  to 300 closed candles and reports broker precision, tick volume, spread and
  real volume.

Before deployment, apply migrations through 064 and deploy the functions,
then compile this EA in MetaEditor. Version 1.0.35 separates a lightweight
all-series freshness sweep from clean historical bootstrap work. New and
re-enabled pairs import up to 1,000 closed candles on all eight timeframes,
while every enabled series continues receiving current candles during that
background bootstrap.

Version 1.0.35 also identifies each attached EA session. Supabase leases a
terminal key to one active session at a time, preventing a local chart and its
VPS copy from executing the same command or publishing conflicting candle
caches. It reports four distinct MT5 trading capability flags so the dashboard
shows the current blocker instead of preserving an old failed-command warning.
Initial and manually requested history now loads in bounded five-second batches,
while normal restarts still resume from Supabase checkpoints. A non-empty but
stale MT5 `CopyRates` cache is actively synchronized and retried instead of
being mistaken for a current feed.

Version 1.0.39 addresses every incremental candle by its missing broker-time
window instead of trusting positions in MT5's possibly stale off-chart cache.
The reporter does not mark a series current until a returned closed candle
advances beyond Supabase's durable checkpoint. MT5 history construction stays
event-driven and retryable, while live-candle work and full-history repairs use
separate scheduling. Priority strategy repairs and background/manual repairs
each receive capacity, so one recurring M5 issue cannot starve other periods.

Version 1.0.40 makes live delivery deadline-driven. Every enabled series is
checked once per second and every series whose broker candle is due is serviced
in the same pass, without priority queues or live-series caps. Captured candles
remain in a local outbox until the backend acknowledges their exact timestamps;
historical bootstrap work cannot run while live delivery is pending.

## Functional behavior

Other behavior is unchanged from v1.0.18 — see the inlined module comments inside
`LucreHubEA.mq5` (or the prior multi-file bundle's README) for the full
description of what each module does: account/position sync and command
execution, economic calendar ingestion, low-latency WebSocket command
pickup, broker symbol mapping, and closed-bar price reporting for the
strategy engine.

## Known limitation (unchanged)

**Not compiled/run inside an actual MetaTrader terminal** — this sandbox
has no MT5 installation. The MQL5 API surface matches MetaQuotes'
published reference and the HTTP/WebSocket sides have been tested
end-to-end against live Supabase, but the compile step itself needs to
happen in your MetaEditor before this goes live.
