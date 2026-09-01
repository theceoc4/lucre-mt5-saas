# Changelog — LucreHubEA (MT5 Expert Advisor)

## v1.0.33 — Verified bootstrap plus non-starvable freshness (2026-09-01)

- Checks the newest three closed candles for every enabled symbol/timeframe on
  every local price pass; history recovery can no longer consume this lane.
- Separately uploads up to two clean 1,000-candle snapshots per pass for new,
  re-enabled, incomplete, or gap-detected series.
- Reads server bootstrap generations and verified history counts from
  `ea-sync`, then immediately refreshes the manifest after successful snapshots.
- Logs broker/timeframe-specific `CopyRates` and synchronization failures and
  retries them without blocking healthy symbols.
- Keeps payloads bounded to 400 series/1,200 freshness bars or two 1,000-bar
  bootstrap series per request.
- Server manifests disable removed or replaced broker mappings so unreachable
  historical rows no longer appear in the active-health total.
- Clean snapshot uploads can now correct existing broker candle values at the
  same timestamp, not just fill missing timestamps.

## v1.0.32 — Durable server candle checkpoints (2026-09-01)

- Reads Supabase's latest accepted candle checkpoint for every broker symbol
  and timeframe from the normal `ea-sync` response.
- Restores local reporting cursors from those checkpoints after an EA,
  terminal, or VPS restart instead of replaying 1,000 candles for every
  selected series.
- Keeps active-strategy series ahead of global background history collection;
  the backend now includes primary, bias, and rule-condition timeframes in
  that priority lane.
- Preserves the existing closed-candle-only model and all eight supported
  timeframes. No live/forming candle is used for signals or backtests.

## v1.0.31 — Active-strategy feed priority and fair rotation (2026-09-01)

- Reports EA v1.0.31 and reads active-strategy timeframe priority supplied by
  `ea-sync`.
- Sends active auto-strategy symbol/timeframe candles before general dashboard
  history so a large visible-symbol list cannot starve trading inputs.
- Rotates priority and background series independently on every pass. Bounded
  backfill and outage recovery remain in place, but skipped series now move to
  the front on following passes instead of getting stuck behind the same work.
- Keeps the same closed-candle payload and database write model; this changes
  scheduling order, not report frequency or per-candle storage volume.

## v1.0.29 — Broker-native adaptive risk and exit telemetry (2026-08-28)

- Reports its EA version so the backend can safely gate newer execution capabilities.
- Sizes strategy orders from percentage-of-balance risk using MT5 `OrderCalcProfit`, the live entry quote, and the protective stop.
- Treats strategy lot size as a hard ceiling and always rounds calculated volume down to the broker lot step.
- Reports MT5 close reasons (SL, TP, manual, expert, stop-out, rollover, or other) for outcome analysis.
- Remains backward-compatible with fixed-volume manual orders and older commands that do not include `risk_percent`.

## v1.0.24 — Ephemeral live position stream (2026-08-25)

- Broadcasts one aggregate mark-to-market snapshot at most every two seconds
  while open-position values are changing; no per-tick database writes. The
  stream runs only while a dashboard renews its short subscription lease and
  stops within 30 seconds after the last viewer disconnects.
- Streams only volume, current price, unrealized P/L, SL and TP. Durable
  `ea-sync` rows remain authoritative for position identity/status and every
  modify/close action.
- Durable healthy snapshots move from 10 to 30 seconds, reducing normal
  database/Edge Function writes by roughly two-thirds. Trade transactions
  still force an immediate durable sync, and disconnected fallback stays at
  five seconds.

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
