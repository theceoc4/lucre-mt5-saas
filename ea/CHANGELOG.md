# Changelog — LucreHubEA (MT5 Expert Advisor)

## v1.0.49 — External custom-indicator bridge (2026-09-04)

- Receives terminal-owned MT5 indicator strategy configuration from the
  existing authenticated `ea-sync` response.
- Loads configured custom indicators with their default Inputs and reads BUY
  and SELL buffers only after a candle closes.
- Relays one idempotent candidate per strategy, broker symbol, timeframe,
  candle and side to the external-signal ingress; risk and execution remain
  server-authoritative.
- Seeds the current closed candle without emitting it on EA start or strategy
  reconfiguration, preventing stale indicator arrows from becoming trades.
- Ships only explicitly versioned `LucreHubEA-v1.49` source and ZIP artifacts.

## v1.0.48 — Quiet standby and resilient private P/L (2026-09-03)

- Pauses every non-socket network lane for 45 seconds when the backend reports
  that another EA owns the terminal lease, eliminating one-second 409 storms.
- Includes the EA instance ID in private position snapshots so a standby copy
  cannot overwrite the authoritative VPS account P/L stream.
- Sends changed broker P/L at the existing two-second cadence and one compact
  unchanged heartbeat every eight seconds, separating stream liveness from
  market movement without returning to per-tick writes.
- Extends the dashboard stream lease to 45 seconds for safe 25-second renewal
  and reports runtime version 1.0.48.

## v1.0.47 — Broker-authoritative live floating P/L (2026-09-03)

- Reports MT5 `ACCOUNT_PROFIT` as the authoritative account floating P/L in
  both the private two-second stream and durable account snapshots.
- Reports `ACCOUNT_CREDIT`, per-position swap, aggregate position profit, and
  aggregate position swap so broker/account differences can be reconciled.
- Immediately sends a private snapshot when the dashboard first leases the
  stream, while retaining changed-state suppression between updates.
- Corrects the runtime `ea_version` payload and ships named
  `LucreHubEA-v1.47.mq5` and `LucreHubEA-v1.47.zip` artifacts.

## v1.0.46 — Private live position transport (2026-09-03)

- Moves ephemeral mark-to-market position snapshots off the public command
  wake-up topic and through an EA-key-authenticated server relay.
- Delivers the snapshot on a private Realtime topic protected by terminal-owner
  RLS; another authenticated user cannot subscribe to it.
- Uses a new lease event that older EAs ignore, preventing a pre-v1.0.46 EA
  from publishing position values on the legacy public lane.
- Keeps durable position reconciliation and every open/modify/close command
  path unchanged, with the normal polling fallback if the private stream drops.

## v1.0.45 — Low-latency trading control plane (2026-09-03)

- Adds a compact command-only exchange so opening, modifying, and closing no
  longer waits behind account history, position reconciliation, symbol state,
  or candle-feed manifest work.
- Pumps the terminal-scoped Realtime channel first on a 250ms timer and uses a
  one-second command-only fallback while that channel is unavailable.
- Returns broker execution results immediately in a second compact exchange
  instead of waiting for the next full reconciliation cycle.
- Defers trade-event account/history reconciliation off the `OrderSend` path
  and broadcasts a fresh ephemeral position snapshot after execution.
- Keeps the durable command queue, active-EA lease, idempotency controls, and
  full reconciliation loop as recovery backstops.

## v1.0.44 — Atomic dashboard close-all (2026-09-03)

- Accepts one `close_all` command from the dashboard and closes every active
  position directly inside MT5 through the existing terminal-wide close path.
- Keeps user-requested close-all commands distinct from automated
  `flatten_basket` risk events in backend command history.
- Reports a single aggregate command result; normal account-history and
  position reconciliation retain broker-confirmed close details per trade.

## v1.0.43 — Bounded snapshots and broker-session truth (2026-09-02)

- Caps each bootstrap payload at the newest 1,000 closed candles after MT5
  closure classification, eliminating the 1,001-row HTTP 413 loop.
- Enforces the five-second bootstrap lane interval and applies bounded
  exponential backoff after rejected or failed uploads.
- Reports broker maintenance/session pauses separately from missing candle
  history, including the latest broker tick when available.
- Detects the first forming candle after a session gap and reports the exact
  next close expected without creating synthetic gap candles.
- Keeps deadline-driven live candle capture ahead of all bootstrap work.

## v1.0.42 — Deterministic all-series candle cursors (2026-09-02)

- Explicitly initializes each per-symbol/timeframe accepted-candle cursor and
  bootstrap generation, preventing random series from inheriting a future-ish
  primitive value and silently dropping out of the deadline scheduler.
- Routes missing, underfilled, and manually requested series directly through
  the 1,000-candle snapshot lane instead of trapping a null checkpoint in the
  incremental retry loop.
- Classifies a candle as closed from its timestamp and timeframe. A one-row
  `CopyRates` response can now publish a just-closed candle even when MT5 has
  not constructed the next forming bar for that off-chart series yet.
- Allows one bounded history repair to proceed while another series is waiting
  on broker history, without overlapping an unacknowledged live upload.
- Initializes all per-pass scheduling arrays before candidate evaluation.

## v1.0.41 — Deterministic live outbox initialization (2026-09-02)

- Explicitly initializes every newly allocated outbox field before appending a
  candle, preventing garbage bar counts and malformed JSON on MT5 VPS builds.
- Validates outbox shape, count, timestamp, and JSON boundaries before upload.
- Self-heals an invalid entry by discarding and reacquiring it from MT5; the
  durable checkpoint never advances until the clean replacement is accepted.

## v1.0.40 — Deadline-driven all-series candle delivery (2026-09-02)

- Replaces the global minute scan with a one-second deadline check for every
  enabled symbol/timeframe; healthy series perform no history or network work.
- Services every due live series without priority ranks or per-run caps.
- Captures candles before account/calendar network work in the shared MT5 timer.
- Retries missing broker candles every second for 15 attempts and every five
  seconds afterward, distinguishing an absent post-boundary broker tick.
- Holds captured live candles in an outbox until `report-bars` explicitly
  acknowledges the exact accepted timestamp.
- Suspends 1,000-candle bootstrap work whenever any live candle is pending.
- Batches all ready live candles into one request and retains them after HTTP,
  mapping, or database failures for idempotent retry.

## v1.0.39 — Exact-time live candle state machine (2026-09-02)

- Replaces position-based incremental `CopyRates(1, n)` reads with explicit
  date-window requests that cannot be satisfied by an old off-chart cache.
- Verifies that the newest returned closed candle advances beyond Supabase's
  accepted checkpoint before declaring a symbol/timeframe healthy.
- Keeps incomplete MT5 timeseries construction on a five-second, event-driven
  retry lane and uploads immediately when a retry succeeds.
- Separates live-candle retries from full 1,000-candle history repair so one
  delayed close never escalates into a large snapshot automatically.
- Reserves one historical-repair slot for priority strategy series and one for
  background/manual repairs, preventing recurring M5 work from starving M1,
  M15, M30, or other timeframes.
- Uses time-addressed history snapshots ending at the current broker time and
  explicitly excludes the still-forming bar zero.
- Logs checkpoint, current-bar, newest-closed-bar, synchronization flags, and
  retry timing for every series that fails to advance.

## v1.0.38 — Authoritative off-chart timeseries refresh (2026-09-02)

- Replaces cached `CopyRates` wake-up probes with uncached `iTime` requests,
  forcing MT5 to obtain the actual current series when a candle should have
  closed or a repair is active, even when no matching chart is open.
- Explicitly activates symbols that MT5 marks selected but keeps invisible as
  internal conversion dependencies, ensuring they receive broker quotes.
- Uses both the current quote and authoritative current-bar time to distinguish
  an active market from a legitimate session closure.
- Reports retry-backoff state instead of leaving frozen series labeled idle.
- Skips healthy series between their expected candle boundaries, keeping the
  authoritative collector workload near 22 reads per minute for 17 symbols
  instead of repeatedly scanning all 136 series.
- Keeps 1,000-candle snapshots, closed-candle-only ingestion, and the existing
  one-minute Supabase write cadence unchanged.

## v1.0.37 — Continuous off-chart candle refresh (2026-09-01)

- Keeps every enabled broker symbol/timeframe cache warm with a bounded,
  rotating local `CopyRates` probe between candle closes; all 136 current
  series are touched in roughly 25 seconds without adding Supabase traffic.
- Corrects the per-series retry gate so a frozen cache waits through its
  backoff and is reread when the retry becomes due, instead of the reverse.
- Preserves the verified 1,000-candle bootstrap lane, closed-candle-only
  uploads, one-minute freshness cadence, and existing repair generations.

## v1.0.36 — Resilient per-series history synchronization (2026-09-01)

- Replaces immediate stale-cache rereads with a timer-driven MT5 history
  synchronization state machine and bounded exponential retry.
- Keeps healthy all-series freshness scans at one minute while retaining a
  five-second lane only for explicitly pending repair work.
- Sends one 1,000-candle repair snapshot per request with a larger HTTP timeout,
  preventing historical uploads from crowding out incremental candles.
- Reports compact per-series collector diagnostics so the dashboard can
  distinguish queued, waiting-for-MT5, retry, and stalled repair states.

## v1.0.35 — Fast bootstrap and stale-cache repair (2026-09-01)

- Runs missing/forced 1,000-candle snapshots in bounded five-second batches
  while preserving the once-per-minute all-series freshness pass.
- Detects non-empty but frozen MT5 `CopyRates` caches when live ticks prove the
  market is active, explicitly requests history synchronization, and retries.
- Avoids repeatedly uploading the same 1,000 frozen candles while waiting for
  MT5 to advance the broker cache.

## v1.0.34 — Active-session lease and capability truth (2026-09-01)

- Adds an opaque per-session ID so Supabase can lease each terminal key to one
  active EA and keep duplicate local/VPS copies in standby.
- Reports terminal, per-EA, broker-account, and account expert-trading flags on
  every durable heartbeat, replacing the ambiguous AutoTrading diagnosis.
- Uses a 240-candle readiness floor while still requesting/retaining up to
  1,000 bars, allowing broker-complete histories such as XRPUSD W1 (485 bars)
  to finish instead of uploading forever.

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
