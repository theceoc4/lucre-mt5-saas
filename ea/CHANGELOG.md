# Changelog — LucreHubEA (MT5 Expert Advisor)

## v1.0.23 — Live position snapshots and explicit P/L costs (2026-08-23)

- Publishes account and open-position snapshots every 10 seconds while the
  Realtime command channel is healthy, and every 5 seconds while reconnecting.
- Reports MT5 deal profit separately from commission, swap and fees so the
  backend can show both trade P/L and true net P/L without double counting.
- Keeps immediate `OnTradeTransaction` synchronization for opens, closes,
  partial fills and SL/TP changes.

## v1.0.22 — Realtime wake-ups and multi-timeframe bars (2026-08-23)

- Replaced continuous two-second command polling with direct Supabase
  Realtime wake-ups plus durable reconciliation: 60 seconds while connected,
  10 seconds if Realtime is unavailable.
- Realtime carries no command or account data. It only tells the EA to call
  the existing API-key-authenticated `ea-sync` endpoint immediately.
- Added closed-candle reporting for M1, M5, M15, M30, H1, H4, D1 and W1 using
  each pair's dashboard-selected timeframes.
- Added staggered 300-candle warm-up, outage recovery checkpoints, broker
  precision, spread and real-volume reporting, and a 1,200-bar request cap.
- The local bar scanner runs every five seconds but only sends when at least
  one selected series has a newly closed candle.

This source must still be compiled in MetaEditor before installation.

## v1.0.18 — Single-file build for VPS compatibility (2026-08-20)

**Packaging-only release — no trading logic changed.**

### Why
The EA previously shipped as `LucreHubEA.mq5` plus five sibling
`.mqh` include files (`EASync`, `CalendarSync`, `EAStream`, `SymbolMap`,
`PriceReporter`) that had to be copied into `MQL5/Include` alongside the
main file in `MQL5/Experts`. MetaTrader VPS hosting does not reliably sync
sibling `.mq5`/`.mqh` source files onto the VPS — it's built around syncing
compiled `.ex5` files, not their include dependencies — so a VPS install
following the old multi-file layout could fail to compile, or run against
stale/missing includes if a file was dropped or updated out of sync with
its `.mq5`.

### What changed
- All five `.mqh` modules are now inlined directly into `LucreHubEA.mq5`.
  MQL5's `#include` is plain text substitution, so the resulting compiled
  `.ex5` is byte-for-byte equivalent to compiling the old five-file layout
  — this is purely a packaging change.
- Each module's original header/doc comments are preserved verbatim in
  place, wrapped in `BEGIN inlined module: X.mqh` / `END inlined module:
  X.mqh` banner comments for navigation.
- A duplicate `#property strict` directive from each module was removed
  (one now covers the whole file, as it always implicitly would have).
- `#property version` bumped `"1.17"` → `"1.18"` to mark this packaging
  build.
- Setup is now one file: copy `LucreHubEA.mq5` into `MQL5/Experts/`,
  compile, attach. Nothing to copy into `MQL5/Include` anymore.

### Not changed
- No behavior, timers, network calls, or command handling changed. This
  is the same v1.0.17 logic (execution client, calendar sync, WebSocket
  push, symbol mapping, price reporting) — see the prior
  `LucreHubEA-v1.0.17--Install-Bundle` CHANGELOG for the functional history
  of each module.

---

## Prior history

See `LucreHubEA-v1.0.17--Install-Bundle.zip` and earlier bundles for the
full functional changelog (execution client, filling-mode fallback,
strategy attribution, stuck-command recovery, economic calendar ingestion,
WebSocket command push, broker symbol mapping, price bar reporting for the
strategy-signal-engine, and the OnTradeTransaction immediate-sync hook).
