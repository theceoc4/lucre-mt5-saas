# Changelog — Lucre Hub Trading Dashboard

All notable changes to the dashboard frontend are documented here. Follows the
same `vMAJOR.MINOR.PATCH` convention as the backend
(`/home/user/workspace/mt5_backend/CHANGELOG.md`) — the two repos version
independently but share the same numbering scheme for easy cross-reference.

---

## v1.0.42 — Reliable strategy toggles (2026-09-01)

- Routes both Overview and Strategies-tab toggles through one authenticated,
  ownership-checked, idempotent database operation that returns the committed
  enabled state.
- Retries transient Safari transport failures safely and keeps both rendered
  toggle surfaces synchronized without a full strategy reload.

## v1.0.41 — Bounded analytics cards (2026-09-01)

- Restores the four Overview summary cards to a consistent fixed height while
  keeping Win Rate, P/L Over Time, and Risk Engine fully visible.
- Makes the Overview Strategies list independently scrollable so any number of
  strategies no longer stretches the full grid row.
- Bounds the Risk Score workspace and moves scenario rows into an internal
  vertical scroll region.

## v1.0.40 — Dashboard workspace and activity center (2026-09-01)

- Adds a fixed-height, scrollable Signals workspace with pair and date-range
  filters, while retaining blocked and downweighted outcomes in the feed.
- Rebuilds Strategies as full-width management cards with win rate, best
  session, edit/toggle controls, repairable stale-pair chips, and aligned
  directional-news controls.
- Moves trade-duration analytics into Overview, removes redundant Blocked and
  Duration tabs, and makes both Positions surfaces fully actionable.
- Adds a live notification center for signal decisions and acceptance, closed
  positions, strategy/feed health, and failed or expired MT5 commands.
- Simplifies navigation labels, greeting, strategy rows, and position-action
  buttons for a more consistent desktop and mobile layout.

## v1.0.39 — Stable pair-card interaction (2026-09-01)

- Keeps the front and back face rotations intact when desktop or mobile Safari
  applies hover styles, preventing oscillation and invisible card backs.
- Flips cards in place instead of rebuilding the full Pairs grid, preserving
  the active back-side controls and avoiding mobile focus/hover remount issues.

## v1.0.38 — Pair feed-health cards and targeted repair (2026-09-01)

- Pair cards flip horizontally to a feed-health view with M1 through W1
  availability derived from real retained history and latest closed candles.
- Red timeframe controls request a rate-limited clean snapshot for exactly that
  terminal, symbol, and timeframe; Realtime updates show repair progress.
- Pair win rate and realized P/L now live on the card back while trading,
  trend, Auto SL/TP, Buy, and Sell controls remain unchanged on the front.
- Stale strategy evaluations automatically request a targeted repair at most
  once per series every five minutes, and touched series prune immediately to
  the newest 1,000 rows.

## v1.0.37 — Active EA ownership and live trading capabilities (2026-09-01)

- Atomically leases each terminal API key to one live EA session, preventing a
  VPS copy and another attached chart/terminal from mixing commands and candles.
- Dashboard AutoTrading warnings now use fresh MT5 capability telemetry and
  identify whether the terminal toggle, EA Properties, broker account, or
  account Expert Advisor permission is blocking trades.
- Historical command failures expire as banner evidence and successful command
  reports clear any prior error message.
- Treats 240+ broker-provided candles as indicator-ready while retaining up to
  1,000; this stops finite histories such as XRPUSD W1 from retrying forever.

## v1.0.35 — Verified candle bootstrap lifecycle (2026-09-01)

- Tracks desired, pending, bootstrapping, live, incomplete, error, and disabled
  state for every terminal/symbol/timeframe series.
- New and re-enabled pairs receive a new clean-bootstrap generation across all
  eight timeframes; normal EA restarts reuse a verified server baseline.
- Strategies remain safely in `Waiting for candle history` until every candle
  series they consume has at least 240 verified retained bars (enough for
  EMA-200 plus warm-up margin).
- Current-candle collection and historical bootstrap now run as independent
  lanes, preventing large snapshots or one unavailable broker series from
  starving the rest of the enabled universe.
- Removed or replaced broker mappings are disabled in the lifecycle manifest,
  so health totals only cover series the terminal can actually report.
- Clean snapshots authoritatively refresh matching broker candles, including
  OHLCV, spread, real volume, and source precision, instead of only filling gaps.
- High-frequency EA heartbeats compare a compact manifest first; database
  reconciliation writes run only when mappings, visibility, or priority change.

## v1.0.34 — Durable broker candle-feed checkpoints (2026-09-01)

- Added a per-terminal, per-symbol, per-timeframe feed-state table initialized
  from the existing 1,000-candle operational cache.
- `report-bars` advances each accepted checkpoint monotonically and returns a
  per-series acknowledgement after the price-bar write succeeds.
- `ea-sync` returns those server checkpoints to EA v1.0.32, eliminating blind
  global backfills after terminal/VPS restarts.
- Active strategies now prioritize every candle series they consume, including
  bias and legacy custom-rule timeframes, while global selected-symbol history
  continues filling in a bounded background lane.

## v1.0.33 — Strategy feed health and evaluation visibility (2026-09-01)

- Strategy cards now show the latest evaluation outcome instead of leaving a
  quiet auto strategy ambiguous. The status distinguishes no setup, session,
  direction, spread, cooldown, risk/policy, stale-candle, EA-version, broker
  mapping, and order-queue outcomes.
- The Strategy Status tab adds the same summary plus the latest reason for
  each configured pair, updated through the existing terminal-scoped Realtime
  channel.
- Health is a compact rolling state per strategy/pair, not an unbounded event
  log. Unchanged states write at most once per five minutes.

## v1.0.31 — Progressive indicator strategy builder (2026-08-31)

- Replaced the template-heavy strategy form with a progressive builder that
  shows indicator parameters only after that indicator is added.
- Added EMA crossover, RSI, ADX, price-vs-EMA, breakout, ATR volatility,
  volume confirmation, trend-strength, and linearity indicators.
- Supports up to four indicators with explicit AND/OR connectors and keeps
  legacy strategies unchanged until a new indicator stack replaces them.
- Consolidated execution into Shadow, Manual, and Auto choices. Manual and
  Auto can now be selected at creation without a mandatory shadow promotion.
- Grouped less-frequent lot, risk, spread, stop, target, trailing, cooldown,
  and position-cap controls under a compact advanced section.

## v1.0.29 — Adaptive strategy risk controls (2026-08-28)

- Strategy setup now uses maximum lot size as a safety ceiling and adds configurable percentage risk per signal.
- Default risk is 0.50% for Momentum Breakout and 0.35% for Confirmed Trend Pullback.
- Strategy status now shows both percentage risk and the maximum-lot ceiling.
- Added clearer execution errors for EA upgrade requirements and broker risk-sizing limits.

## v1.0.28 — Strategy rebuild and simplified trend meter (2026-08-27)

- Renamed the pair-card meter to Trend Strength and removed its numeric score;
  the directional visual, status, regime, and Realtime behavior remain intact.
- Retired the four original strategy presets. Existing configurations are
  disabled and hidden, while their historical signals and trades are retained.
- Added Aggressive Momentum Breakout and Moderate Confirmed Trend Pullback.
  Both evaluate closed OHLC candles with EMA, RSI, ADX, and ATR-based risk.
- Strategy configurations now own an explicit M1–W1 timeframe. The Add/Edit
  flow lets the user choose strategy, one or more visible pairs, and timeframe;
  manual-confirm signal lifetime scales to the selected candle duration.

## v1.0.27 — Pair-card action alignment (2026-08-27)

- Pair-card quick-order actions now place SELL on the bearish left side and
  BUY on the bullish right side, matching the trend-strength meter above.

## v1.0.26 — Live layered trend-strength meters (2026-08-27)

- Pairs cards now render a signed `-100` to `+100` trend score instead of the
  placeholder. The label exposes strength and market regime, while hovering
  shows the contributing timeframe scores.
- Meter values arrive over the terminal's existing Supabase Realtime channel.
  The dashboard performs one initial read but adds no per-minute browser poll.
- The backend combines EMA structure/slope, RSI, directional movement, ADX,
  price-path linearity, persistence, and ATR shock detection across M1, M5,
  M15, H1, H4, and D1 closed candles.
- Indicator checkpoints advance from each newly closed candle. Full candle
  history is read only during first warmup or a future model-version change.

## v1.0.25 — System-wide symbol visibility and one-click orders (2026-08-27)

- The top-nav gear now opens a terminal-scoped symbol manager. It lists every
  resolved broker mapping, filters locally as the user searches, pairs new
  symbols through the existing EA scan workflow, and stores visibility with
  the existing `symbol_settings.enabled` preference.
- Hidden symbols are removed from the Pairs page, New Order selector, and new
  strategy symbol picker without deleting mappings or historical trade data.
  Visibility changes produce one database upsert only when a toggle changes.
- The New Order modal is reduced to symbol, lot size, and dedicated BUY/SELL
  actions. Existing per-pair automatic SL/TP defaults are still honored under
  the simplified surface, and the modal closes when the order is accepted.
- The Pairs page no longer contains mapping/search controls or timeframe chips.
  Each enabled card now has a centered, non-functional BUY-vs-SELL strength
  meter placeholder using the dashboard's existing bearish/bullish palette.

## v1.0.24 — Ephemeral live position stream (2026-08-25)

- The dashboard joins the same high-entropy, terminal-scoped Realtime topic
  as the EA, renews a short viewer lease, and overlays changed mark-to-market
  fields every two seconds. The EA stops streaming when no dashboard is open.
- Stream data cannot replace durable row identity/status, so existing Modify
  and Close actions continue to use the same database-backed position IDs.
- Stream values expire after ten seconds and automatically fall back to the
  durable database snapshot if the socket stops delivering.

## v1.0.23 — Order completion, reconcilable P/L, and scalable live positions (2026-08-23)

- The New Order modal now closes as soon as the backend accepts the order.
  Any later MT5 execution failure remains visible in the dashboard status
  banner rather than trapping the user in the modal.
- Cumulative trade P/L now uses the same gross MT5 profit values shown for
  trades; net P/L after commission, swap and fees is displayed separately.
- A healthy Supabase Realtime subscription is now the primary update path.
  The browser performs one safety reconciliation per minute and only falls
  back to eight-second polling while Realtime is disconnected.

## v1.0.19 — Root-cause fix for scenario-stats cold start, honest Risk Engine numbers, true multi-select symbol picker, reordered nav, and an account history modal (2026-08-21)

### Root cause: scenario stats / adaptive throttle ladder never warmed up
- Traced the "24 pending verification" / empty win-rate / "0 signals downweighted"
  symptoms back to `scenario_stats` (and the `agent_policies` throttle ladder it
  feeds) never accumulating rows. `compute_scenario_stats()` requires
  `trade_history` rows with a non-null `strategy_id` + `session` + `htf_regime`,
  but `session`/`htf_regime`/news context was only ever attached to the
  *opening* `ea_commands` row at signal time and never copied onto `positions`
  itself — so only one of three close paths (the executed-close-command path)
  could ever populate it. The closed-deals report handler and the stuck-position
  reconciler had no way to recover that context, leaving most closed trades
  without scenario context and the ladder permanently cold.
- Backend fix (see `backend/schema/migrations/038_position_scenario_context.sql`):
  `positions` now stores its own `session`, `htf_regime`, `near_news_event`,
  `news_event_id`, captured the first time a position is seen from its
  originating "open" `ea_commands` row (matched by `mt5_ticket`). `ea-sync`
  (`backend/functions/ea-sync/index.ts`, redeployed as function version 7)
  populates and propagates these columns through every close path so
  scenario context survives regardless of which path closed the trade.
- `backend/schema/migrations/039_scenario_stats_profit_verified_filter.sql`
  adds a `profit_verified = true` filter to `compute_scenario_stats()`,
  `throttle_sweep()`, and `trg_recompute_scenario_on_trade_close()`, so
  placeholder `profit = 0` rows for trades the EA never actually reported a
  result for can no longer silently drag scenario stats toward zero.

### Fixed: Risk Engine always showing 0 signals downweighted
- `renderRiskEngine()` previously derived the downweighted count from
  `state.agentPolicies` (the same scenario-level throttle ladder above) —
  a table that stays empty until scenario stats warm up, which per the root
  cause above could take indefinitely long. It now counts directly from the
  dashboard's own signal feed (`state.signals.filter(s => s.policy_decision
  === 'downweight')`), which already carries a per-signal decision and needs
  no separate table to warm up.

### Clarified: "N pending verification"
- Added a shared `pendingVerificationLink()` helper producing a clickable,
  underlined "N pending verification" snippet with an explanatory tooltip,
  wired into every metrics view that reports a pending count (strategy win
  rates, the main Win Rate card, Sessions/Win Rate/Duration tabs). Clicking
  the link opens the new Account History modal (below) pre-filtered to
  pending trades, so there's finally a concrete place to go look.

### Added: scrollable Account History modal
- The dashboard's dead "Positions Closed →" footer link now opens a new
  Account History modal listing every closed trade in a scrollable list,
  with "All trades" / "Pending verification" filter tabs and an explainer
  paragraph when viewing the pending filter. Any pending-verification link
  anywhere on the dashboard opens this modal pre-filtered via a shared
  `data-open-account-history` delegated click handler.

### Changed: symbol/pair picker is now a real multi-select
- Replaced the single-select pair/symbol dropdown in Add Strategy with a
  custom checkbox-based popover (`.symbol-multiselect`): open it, check as
  many pairs as you want across categories, then hit Add once to add them
  all together — no more one-at-a-time selecting. (Deliberately not a
  native `<select multiple>`, which was removed in v1.0.12 because it needs
  Cmd/Ctrl to multi-select and doesn't multi-select on many mobile browsers.)
- Fixed the category order shuffling on every reopen (FX/Metals/Indices/
  Crypto no longer reorder themselves based on selection history) — the
  checklist now renders groups in one fixed, stable order every time.

### Changed: second nav bar (Signals/Overview/Positions/Sessions/…)
- Overview is now the first tab in DOM order and remains the default view
  on load, matching how it's already treated as the default (`main.js`
  already called `setActiveTab('overview')` on load — only the tab order
  itself needed correcting).

---

## v1.0.15 — Real fix for stuck positions/zero metrics, honest "pending verification" labeling, and a cleaner strategy row (2026-08-20)

v1.0.14 wired up live subscriptions and metric math, but the underlying data
was still corrupted by a stale EA build that never reported closed trades
(see `mt5_backend` CHANGELOG v1.0.18) — so the same three complaints came
back after real trading: positions stuck as "open" that 409'd when closed,
Win Rate/P&L/R:R still at zero even for manual trades, and a broken Strategy
Performance card layout after adding Edit.

### Fixed: "position no longer open" error on Close
- `renderPositions()` (dashboard's Positions card) previously rendered live
  Modify/Close buttons for every row in `state.positions`, including ones
  with `status='closing'` — but `position-action` correctly rejects any
  position that isn't `status='open'` with a 409 `position_not_open`. That
  mismatch was the literal cause of the "position is no longer open" error.
- A `status==='closing'` row now renders a disabled "Reconciling…" badge
  instead of live buttons, so there's nothing left to click that could 409.
  Paired with the backend's new self-healing reconciler (`mt5_backend`
  v1.0.18), these rows now also clear themselves automatically within a few
  minutes instead of sitting stuck indefinitely.

### Fixed: Win Rate / P&L / R:R showing zero
- `loadTradeHistory()` now also selects the new `trade_history.profit_verified`
  column.
- `renderWinRate()`, `renderStrategyWinRates()`, `getFilteredTradeHistoryForPl()`
  (feeds the P&L chart), `renderSessionsTab()`, `renderWinRateTab()`, and
  `renderDurationTab()` now all exclude rows where `profit_verified === false`
  from win/loss/P&L/R-multiple math via a shared `getVerifiedTradeHistory()`
  helper, instead of quietly averaging in placeholder `profit=0` rows written
  for trades the EA never actually reported a result for.
- Rather than silently showing 0% with no explanation (the original
  complaint) or silently dropping unverified trades with no trace, every
  affected view now surfaces an honest count — e.g. the Win Rate gauge's
  sub-label reads "Below target · 3 pending verification", and the
  Sessions/Win Rate/Duration tabs show a dedicated note — so it's clear the
  dashboard isn't broken, the underlying trade data is still catching up.
- This is the dashboard-side half of `mt5_backend` v1.0.18's fix; see that
  changelog for why the corrupted rows existed in the first place and how
  new ones are prevented going forward regardless of EA version.

### Fixed: Strategy Performance card layout (text overlap after adding Edit)
- Removed the row-level `Delete` button — strategy deletion is now only
  available inside the Edit modal (already fully wired via
  `#button-delete-strategy`; no behavior change there, just one less control
  competing for space on the row).
- Added `flex-shrink: 0` guarantees on the toggle label and action buttons
  and `text-overflow: ellipsis` on the strategy subtitle line, so long
  strategy names/subtitles truncate cleanly instead of wrapping and
  colliding with the controls next to them.

### Testing
- `node --check main.js` — passes.

---

## v1.0.14 — Live metrics, strategy edit/delete, and a shorter News Events list (2026-08-20)

Four dashboard-side changes shipped alongside `mt5_backend` v1.0.17's fixes
for the same underlying issues reported live after a user took several real
trades.

### Live trade_history subscription
R:R, Win Ratio, and P&L on the Performance/Strategy/Sessions tabs previously
only updated on a manual page reload or terminal switch, because
`public.trade_history` was never in the `supabase_realtime` publication
(fixed backend-side in migration `037_realtime_trade_history.sql`).
`startRealtime()` now also subscribes to `INSERT` events on `trade_history`
and calls `loadTradeHistory()` on every newly-finalized close, so every
metric derived from it updates live. As a belt-and-suspenders fallback in
case a Realtime channel drop is ever missed, the existing 8-second position
poll loop also now calls `loadTradeHistory()` on every tick.

### Strategy edit and delete
The Strategy Status tab previously only supported create + enable/disable
toggle. The "Add strategy" modal now doubles as an edit modal: each strategy
row gets an **Edit** button that opens the same form prefilled with its
current kind, name, delivery mode, pairs, and max lot size, and submits an
`update()` instead of an `insert()`. Each row also gets a **Delete** button
that confirms, then deletes the strategy (`strategies` FKs already cascade
/ set-null cleanly — no schema change needed).

### News Events tab: shorter, fixed-height, scrollable list
`loadCalendarEvents()`'s query limit was reduced from 100 to 30 (still
most-recent-first), and `#tab-news-events-list` now renders inside a
fixed-height (420px) card with its own scroll region (`.mini-table-scroll`)
instead of an ever-growing unbounded list, so older events scroll into view
within the card rather than pushing the rest of the page down.

### New-account onboarding note
The "new accounts must wait ~2.5 hours for a first signal" issue was fixed
entirely on the backend side (`mt5_backend` v1.0.17, `PriceReporter.mqh`
historical backfill) — no dashboard changes were needed for that fix.

### Not included in this release
- Cannot backfill correct P&L for trades closed before the backend fix
  (tickets 157334, 157598, 157805) — see `mt5_backend` CHANGELOG v1.0.17.

---

## v1.0.13 — Fix: Add-Strategy insert always failed on signal_family NOT NULL (2026-08-19)

Fixes a fully blocking bug reported live right after the v1.0.12 pair-picker
rebuild: saving a strategy failed with `null value in column
"signal_family" of relation "strategies" violates not-null constraint`.

### Root cause
`public.strategies.signal_family` has been a required column (`NOT NULL`,
no default) since `mt5_backend/migrations/020_strategy_signal_family_and_
direction.sql` shipped in backend v1.0.3 — but no insert path in this file
ever supplied it. Every Add-Strategy submission through the dashboard has
failed this way since that migration, confirmed by the `strategies` table
having zero rows in Supabase despite the backend's signal engine having
been live since v1.0.14. The v1.0.12 pair-picker fix simply made it
possible to reach the submit step and hit this error for the first time.

### Fix
Added `STRATEGY_KIND_SIGNAL_FAMILY`, mapping each implemented strategy
`kind` to the architecture spec's `signal_family` taxonomy (§5.2, S1–S10
catalog), and included the mapped value in the insert payload:
- `vwap_reversion` → `vwap_reversion` (direct match, S2/S8)
- `orb_breakout` → `breakout` (S3, opening range breakout)
- `bb_fade` → `support_resistance_bounce` (S6 — fades a tested band/level
  with rejection-wick confirmation, the same pattern `bb_fade`'s entry
  logic implements against the Bollinger Band)
- `ema_trend` → `momentum` (S1 — fires at the EMA9/EMA21 crossover itself,
  i.e. momentum continuation, not a pullback-entry or H4 swing setup)

Verified against `information_schema.columns` that every other `NOT NULL`
column on `strategies` (`delivery_mode`, `max_lot_size`, `signal_ttl_seconds`,
`config`, `news_posture`, `news_window_minutes`, `news_min_impact`,
`news_exploit_size_multiplier`) has a database default, so `signal_family`
was the only gap.

### Files changed
- `main.js` — `STRATEGY_KIND_SIGNAL_FAMILY` map, Add-Strategy submit payload.

### Not included in this release
- Not live-tested end-to-end against a real terminal in this environment;
  verified by reading the live schema directly (`information_schema.columns`,
  the `strategies_signal_family_check` constraint values) and confirming the
  chosen mapping values are all in the allowed set.

---

## v1.0.12 — Realtime refresh fix + Add-Strategy pair picker rebuild (2026-08-19)

Fixes two bugs reported live right after v1.0.11 shipped: the dashboard
didn't refresh in anything close to realtime (~1 minute to show an
opened/closed position, several minutes for account balance), and the
Add-Strategy modal's Symbols field had no way to confirm a selection had
actually "stuck" — blocking strategy creation entirely for some users.

### Fix: realtime + balance refresh latency
- **Root cause found:** `public.mt5_terminals` was never added to the
  `supabase_realtime` publication, even though the v1.0.11 balance widget's
  `startRealtime()` subscription depends on `UPDATE` events from exactly
  that table — the subscription was subscribed to nothing, and there was no
  polling fallback for balance at all. Fixed server-side by
  `mt5_backend/migrations/036_realtime_terminals_and_positions_tuning.sql`
  (see that repo's CHANGELOG v1.0.15).
- Added `refreshActiveTerminalBalance()` — a lightweight single-row poll of
  `equity`/`balance`/`margin_level`/`status`, run on the same tick as the
  position poll, as a safety net independent of Realtime.
- Reduced `POSITION_POLL_MS` from 30s to 8s.
- `startRealtime()`'s `.subscribe()` call previously had no status
  callback at all — added one that logs channel state and automatically
  retries (3s backoff) on `CHANNEL_ERROR`/`TIMED_OUT`/`CLOSED` instead of
  silently falling back to nothing but the poll loop until a manual reload.
- Backend/EA-side latency: `LucreHubEA.mq5` had no `OnTradeTransaction()`
  handler, so every trade event waited out `EASync`'s 2s poll gate before
  the backend even learned about it. Fixed EA-side this release too — see
  `mt5_backend` CHANGELOG v1.0.15 and the new EA install bundle.

### Fix: Add-Strategy modal — pairs wouldn't visibly "stick"
- **Root cause:** the Symbols field was a native `<select multiple
  size="5">`. Clicking a pair without holding Cmd/Ctrl replaced the
  previous selection instead of adding to it, and there was no visible
  confirmation of what was actually selected — on mobile, multi-select
  wasn't practically usable at all. Users could not tell their pairs had
  been dropped until the save attempt silently failed or saved the wrong
  set.
- Replaced with a single-pick dropdown + explicit **Add** button that
  appends the chosen pair to a persistent, visible chip list. Each chip has
  its own **×** remove control. Selections are tracked in a plain JS array
  (`strategySelectedSymbols`) instead of native multi-select state, and the
  submit handler now reads from that array — fixing both the UX ambiguity
  and the underlying bug where selections could be lost before submit.
- A pair already added is removed from the dropdown (can't add the same
  pair twice); removing a chip puts it back in the dropdown.

### Files changed
- `index.html` — Add-Strategy modal Symbols field markup.
- `main.js` — `populateStrategySymbolSelect()`, `renderStrategySymbolChips()`,
  Add/remove chip handlers, submit handler now reads `strategySelectedSymbols`,
  `refreshActiveTerminalBalance()`, `startRealtime()` reconnect logic,
  `POSITION_POLL_MS` constant.
- `style.css` — `.symbol-picker-row`, `.symbol-chip-list`, `.symbol-chip`.

### Not included in this release
- Not live-tested against a real connected MT5 terminal in this environment
  (no MT5 installation available here) — verified by code review
  (Supabase publication membership queried directly, JS syntax-checked).
  Please confirm balance now updates within ~15s of a trade closing and
  that positions show up within ~8-10s worst case.

---

## v1.0.11 — Account balance widget, redesigned Add-Strategy flow, P/L filters, mobile/iOS fixes, add-a-pair workflow (2026-08-19)

Bundles everything built since v1.0.10 into one release per the project's
strict patch-increment convention. Closes out items 3, 5, 6, 10, 12, and 13
from the outstanding backlog.

### Added
- **Item 12 — account balance widget.** Always-visible balance/equity/margin
  level card at the top of the dashboard, sourced directly from
  `mt5_terminals` on the active terminal. Also surfaces a top-of-dashboard
  warning banner when `AutoTrading` looks disabled on the connected
  terminal, so a silently-rejected order isn't the first sign of trouble.
- **Item 3 — P/L Over Time card rewrite.** Replaced the old count-based
  win/loss view with a real cumulative P/L line, driven by two new filters:
  a timeframe selector and a Manual / Auto / All source filter
  (`getFilteredTradeHistoryForPl()`, `renderPlChart()` rewritten on top of
  the existing `hexToRgba()` helper). Adds a running summary value above
  the chart so the filtered total is visible without reading the axis.
- **Item 13 — "add a new pair" workflow on the Pairs page.** Inline form to
  register a new canonical symbol for a terminal ahead of the broker's next
  symbol scan; new rows land as `pending_manual` in `symbol_mappings`
  (backend: `bind-symbol` edge function + migration 033) until resolved.
- **Item 10 — Add-strategy modal cleanup.** "Symbols" is now a dropdown of
  this terminal's actual bound/resolved symbols instead of free text;
  "Maximum lot size" relabeled to "Starting lot size" to match how the field
  is actually used (a per-signal base volume, scaled up by the backend's
  win-probability position multiplier — see `mt5_backend` v1.0.14).
- Redesigned "Add a strategy" flow (item 3's companion UI work): pick one of
  the four live preset strategies (`vwap_reversion`, `orb_breakout`,
  `bb_fade`, `ema_trend`), select pairs, name the config, choose
  auto/manual delivery — matching exactly the `StrategyRow.kind` values the
  backend's `strategy-signal-engine` expects (verified no drift this
  release).

### Fixed
- **Item 5 — mobile browser default zoom.** Dashboard was zoomed in by
  default on mobile Safari/Chrome with no way to fit the screen without a
  pinch-zoom. Global floor on form control font-size (inputs/selects no
  longer resolve to a size mobile Safari auto-zooms to focus) plus viewport
  meta adjustments.
- **Item 6 — iOS "Save Password?" alert.** iOS was showing its native
  save-password prompt after manual order/login-adjacent form submissions.
  Suppressed via form attributes so the order flow doesn't get interrupted
  by an unrelated system dialog.

### Not included in this release
- Real-time (non-polling) dashboard refresh (item 9) — not addressed this
  release; dashboard still polls Supabase on an interval rather than
  subscribing to Realtime changes.
- Not live-tested against a phone/tablet browser in this environment (no
  mobile device available here) — item 5/6 fixes follow standard
  documented patterns for iOS Safari zoom and autofill suppression; please
  confirm on an actual device after this update ships.

---

## v1.0.10 — Fix: symbol_unavailable on manual orders outside the Pairs page (2026-08-18)

Fixes a bug where placing a manual order through the "New manual order"
modal (as opposed to a Pairs-page quick Buy/Sell) could fail with
`something went wrong (symbol_unavailable)`. Root cause: the modal's Symbol
field was a free-text input with no validation, so any typo or
not-actually-mapped symbol was sent straight to `manual-order`, which
correctly rejects anything not present in this terminal's `symbol_mappings`.
The Pairs page never hit this because its quick-order buttons always sourced
an exact, known symbol from a hardcoded 14-pair list — which was itself
badly out of sync with the backend's full 51-symbol canonical universe
(`mt5_backend` v1.0.12: FX majors + crosses, metals, indices, crypto).

### Fixed
- **New Position modal Symbol field is now a dropdown, not free text.**
  `#order-symbol` (`index.html`) changed from `<input type="text">` to
  `<select>`, populated by the new `populateOrderSymbolSelect()` in
  `main.js` every time the modal opens. Options are grouped by asset class
  (Forex / Metals / Indices / Crypto) and sourced from
  `getAvailableSymbols()` — the same resolved-symbol list the Pairs page
  now uses (see below) — so a submitted order can only ever reference an
  exact, broker-resolved canonical symbol. If nothing has been mapped yet
  for the active terminal, the dropdown shows a disabled placeholder
  pointing the user at the Pairs page's "Rescan Symbols" action instead of
  letting the form submit a doomed order.
- **`form-new-order` submit handler** no longer runs `.trim().toUpperCase()`
  on a free-typed string — it reads the exact value straight from the
  select, and now refuses to submit (with an inline message) if no mapped
  symbols exist yet on this terminal.

### Changed
- **Pairs page symbol list is now dynamic, not hardcoded.** `SYMBOL_UNIVERSE`
  (`main.js`) was a fixed 14-symbol FX+metals array missing every index and
  crypto pair, and — more importantly — could offer a symbol on the Pairs
  page that wasn't actually resolved for a given broker. `loadSymbolSettings()`
  now builds the Pairs grid from `getAvailableSymbols()` (this terminal's
  resolved `symbol_mappings` rows) whenever a scan has happened, so both
  entry points — Pairs quick Buy/Sell and the New Position modal — always
  agree on exactly what's tradable on this terminal. `SYMBOL_UNIVERSE` is
  now only a pre-scan bootstrap fallback (expanded to the full 51-symbol
  canonical list so a brand-new terminal has the complete set to configure
  before its first scan lands), never the source of truth for what an order
  can actually reference.
- `loadSymbolMappings()` is now awaited before `loadSymbolSettings()` on
  both terminal load and terminal switch (previously ran in the same
  `Promise.all`, so `symbolSettings` could build from stale/empty mappings).

### Investigated, not changed
- Looked for a confirmation dialog / "are you sure" step before a manual
  Buy or Sell fires, per a separate user report about scalping latency.
  Found none in this codebase: both the Pairs page quick-order buttons
  (`handleQuickOrder`) and the New Position modal's submit handler already
  call `placeManualOrder()` immediately with no blocking prompt. The only
  `confirm()` in the dashboard guards closing a position, not opening one.
  Left as-is pending clarification on where the reported message actually
  appears (see conversation).

---

## v1.0.9 — Broker symbol mapping UI (2026-08-18)

Surfaces the backend's v1.0.12 broker symbol mapping feature (`mt5_backend`
CHANGELOG) — lets a user trigger a rescan of their broker's symbol universe
and resolve any ambiguous matches directly from the dashboard, instead of
needing a database console. Ships alongside the backend's persistent
WebSocket push (EAStream.mqh); this release only touches the frontend half
(symbol mapping resolution) since the WebSocket change has no dashboard UI
surface of its own.

### Added
- **"Rescan Symbols" button (Pairs tab)** — new `#button-rescan-symbols`
  in a `Broker symbol mapping` card above the pair grid. Calls the new
  `rescanSymbols(terminal_id)` export in `edge-functions.js`, which POSTs to
  the `request-symbol-rescan` edge function (`mt5_backend` v1.0.12). Since
  the EA only picks up the rescan flag on its next `ea-sync` poll and
  `report-symbols` runs asynchronously after that, the button shows
  "Scanning…" and polls `mt5_terminals.force_symbol_rescan` every 5s (up to
  60s) via `refreshActiveTerminalScanStatus()`, then reloads
  `symbol_mappings` once the flag clears.
- **Symbol mapping status line** — shows last scan time
  (`mt5_terminals.last_symbol_scan_at`), an in-progress state while a scan
  is pending, or a first-time hint if the EA has never reported (pre-v1.0.12
  EA builds).
- **`needs_review` resolution table** — `loadSymbolMappings()` /
  `renderSymbolMappingPanel()` read `symbol_mappings` directly via the
  authenticated Supabase client (RLS-permitted per migration
  `031_symbol_mappings_and_rescan.sql` — no edge function needed for this
  read/update, only for triggering the rescan itself). Ambiguous matches
  (`needs_review = true`) render as a row with the canonical symbol, asset
  class, and a `<select>` of every broker symbol seen as a plausible
  candidate at last scan; picking one and clicking Save calls
  `resolveSymbolMapping()`, which updates `broker_symbol`, sets
  `match_type = 'manual'`, and clears `needs_review`.
- **Summary badges** — mapped / needs review / unavailable counts
  (`.symbol-mapping-summary`, reusing the existing `.tag-badge` visual
  language) above the table so the overall mapping health is visible at a
  glance without reading every row.
- New CSS: `.symbol-mapping-card`, `.symbol-mapping-head`,
  `.symbol-mapping-table` (+ `-wrap`), `.symbol-mapping-summary`,
  `.symbol-mapping-row.is-saving` in `style.css`.

### Not included
- No UI for the `exact` / `auto_prefix` mappings that resolved themselves
  automatically — only `needs_review` rows require a dashboard action, per
  the backend's design (`migrations/031_symbol_mappings_and_rescan.sql`).
- No way to manually override an already-resolved (`exact`/`auto_prefix`)
  mapping from this UI yet — only `needs_review` rows are editable. A future
  update could add a "view all mappings" expandable list if that's wanted.
- Cannot be end-to-end tested against a live EA in this session (no MT5
  terminal available) — verified via injected state through the read-only
  Supabase RLS/edge-function contracts.

---

## v1.0.8 — Directional news policy UI (2026-08-17)

Surfaces the backend's v1.0.6–v1.0.7 directional news policy (`mt5_backend`
CHANGELOG) in the dashboard for the first time — strategy configuration and
per-signal news context were previously invisible in the UI even though the
backend already computed and applied them on every signal.

### Added
- **News Policy panel (Strategy Status tab)** — new `.news-policy-panel`
  block per strategy card with editable `news_posture` (avoid/neutral/
  exploit), `news_window_minutes`, `news_min_impact`, and
  `news_exploit_size_multiplier` fields (`.news-policy-fields` /
  `.news-policy-field`), a posture tag (`NEWS_POSTURE_TAG_CLASS`/
  `NEWS_POSTURE_LABEL` — warn/neutral/ok styling for avoid/neutral/exploit)
  and a plain-language hint per posture (`NEWS_POSTURE_HINTS`) explaining
  what that posture does before the user changes it. Fields disable
  (`.is-disabled`) with an explanatory note when a posture makes them
  irrelevant (e.g. window/impact fields under `neutral`).
- **Per-signal news context (Signals + Blocked tabs)** — `signalNewsDetail()`
  renders a `.news-figures` line under any signal tagged `near_news_event`:
  which event it was near, the resulting `suggested_volume`, and the
  `policy_decision` that produced it, so a downweighted or blocked signal's
  reasoning is visible without a database lookup.
- **Calendar event bias (wherever calendar events are listed)** —
  `calendarEventBias()` shows forecast/previous/actual figures
  (`.news-figures`) plus a bias tag when a released event's surprise vs.
  baseline is directionally clear, using the same
  higher-is-bullish/aligned/opposed logic the backend's
  `apply_news_policy()` uses server-side.

### Explicitly NOT a policy engine
`signalNewsDetail()` and `calendarEventBias()` are display-only
approximations for readability — the authoritative decision is always
`apply_news_policy()` running server-side in Postgres (see `mt5_backend`
CHANGELOG v1.0.7 §B). Both functions are commented in `main.js` as
approximations, not a client-side reimplementation of the policy, to avoid
any drift between what the dashboard displays and what the backend
actually decided.

### QA
- Verified against a temporary Supabase test fixture (test strategies,
  calendar events, and a dedicated auth user), then fully cleaned up —
  zero test rows or test users remain.
- Desktop and mobile (390px) layouts checked on the Strategy Status,
  Signals, and Blocked tabs — news policy fields and the near-news detail
  line wrap cleanly with no overflow at mobile width.
- Dark mode checked on the Strategy Status tab and News Policy panel —
  clean rendering, adequate contrast on all fields/tags/hints.

---

## v1.0.6 — Lucre Hub rebrand (2026-08-17)

Replaced the "Meridian (placeholder name)" branding across the app with the
final product identity: **Lucre Hub**.

### Added
- **New logo mark** — a chartreuse coin containing the same chart-line glyph
  used by the old placeholder icon, now circular and slightly larger (34px →
  38px) in the header/auth-gate lockup.
- **Wordmark** — "Lucre" (bold) set tight against "Hub" (regular weight), no
  separator, matching the finalized brand lockup spacing.
- **Favicon set** — `assets/favicon.svg`, `favicon-32.png`, `favicon-16.png`,
  and `apple-touch-icon.png` generated from the new mark and wired up via
  `<link rel="icon">` / `<link rel="apple-touch-icon">` in `index.html` (the
  app previously shipped with no favicon at all).

### Changed
- `<title>` and meta description updated from "Meridian" to "Lucre Hub".
- Removed the `(placeholder name)` tag next to the topnav wordmark.
- `.brand-mark` CSS: `border-radius` changed from `var(--radius-md)` (rounded
  square) to `50%` (circle); size increased to 38px.
- Replaced `.brand-word` / `.brand-tag` with `.brand-wordmark` /
  `.brand-lucre` / `.brand-hub` to support the two-weight wordmark treatment.
- Internal code identifiers renamed for consistency (no user-facing effect):
  `window.MeridianUI` → `window.LucreUI`, custom events
  `meridian:theme-changed` / `meridian:auth-tab-changed` →
  `lucre:theme-changed` / `lucre:auth-tab-changed`, and the
  `localStorage` feature-detection test key in `supabase-client.js`.
- File header comments in `style.css` and `supabase-client.js` updated to
  reference Lucre Hub instead of Meridian.

---

## v1.0.5 — Functional analytics tab strip (2026-08-17)

The center nav strip ("Signals / Overview / Positions / Sessions / Blocked /
Risk Score / Win Rate / Duration / News Events / Strategy Status") previously
rendered as plain links with no `data-view`/click behavior — selecting any of
them just scrolled to the top of the page. All nine non-Overview tabs are now
fully wired to real Supabase data.

### Added
- **ARIA tab semantics** — the strip is now `role="tablist"` with each link as
  `role="tab"` plus `aria-selected`, toggled by a single `setActiveTab(tab)`
  function. Exactly one tab is `aria-selected="true"` and one panel is visible
  at any time; verified via Playwright across all 10 tabs.
- **Nine new data-backed panels**, each replacing the old dead-link behavior
  with a real render function reading from `state`:
  - **Signals** — every signal for the active terminal with policy decision
    (OK / Blocked / Downweighted) and timestamp.
  - **Positions** — open positions with SL/TP detail (the Overview card is a
    trimmed summary; this tab shows the full detail view).
  - **Sessions** — closed-trade win rate and average R-multiple broken out by
    Asia / London / New York / Overlap.
  - **Blocked** — signals the risk engine blocked or downweighted before
    delivery.
  - **Risk Score** — nightly-computed Bayesian-shrunk win rate per
    strategy/symbol/session/regime scenario, from the new `scenario_stats`
    loader.
  - **Win Rate** — dedicated per-symbol deep-dive (closed/won/lost/breakeven
    counts, avg R-multiple, per-symbol win-rate breakdown) — split out from
    the old mixed-metrics Overview gauge, which now only shows the
    at-a-glance percentage.
  - **Duration** — avg/median hold time plus a bucketed distribution
    (< 15 min, 15–60 min, 1–4h, 4h+).
  - **News Events** — upcoming/recent high/medium/low-impact economic events
    from the new global `calendar_events` loader.
  - **Strategy Status** — enabled/disabled state, symbols, delivery mode, max
    lot size, and signal TTL per strategy.
- **New loaders** — `loadCalendarEvents()` (global table, loaded once in
  `bootDashboard()` alongside `loadTerminals()`, independent of the selected
  terminal) and `loadScenarioStats()` (terminal-scoped, added to both
  `Promise.all` orchestration points). Extended the `select` columns on
  `loadTradeHistory()`, `loadSignals()`, and `loadStrategies()` to pull the
  session/regime/news/outcome and delivery/TTL fields the new tabs need.
- **Mobile scroll-fade affordance** — on narrow viewports the 10-tab strip
  overflows and scrolls horizontally; a right-edge fade now appears whenever
  there's more to scroll and disappears at the end, so the cut-off tab list
  no longer looks broken or dead-ended on mobile.

### Fixed
- Tab links no longer navigate anywhere (`href="#"` dead-link pattern fully
  removed) — all 10 are `javascript:void(0)` with real click handlers.

---

## v1.0.4 — Mobile navigation + link cleanup (2026-08-16)

Fixes reported mobile-navigation gap: the Pairs page (and all secondary nav
links) had no way to be reached from mobile-width or narrow-window browsers.
Also removes dead links from the primary nav that were flagged as redundant.

### Fixed
- **Mobile navigation unreachable** — below the 640px breakpoint the nav pill
  bar (`#nav-pills`) was previously just hidden (`display: none`) with no
  replacement affordance, so the Pairs page and any secondary link were
  completely unreachable on mobile web. Added a hamburger menu toggle
  (`#nav-menu-toggle`, `data-testid="button-nav-menu-toggle"`) that appears
  only at ≤640px and opens `#nav-pills` as an absolutely-positioned dropdown
  directly beneath the top bar.
- **Dead/redundant nav links removed** — the primary nav previously listed
  seven links ("Home", "Signals", "Positions", "Strategies", "Journal",
  "Analytics", "Pairs"), but five of them ("Home", "Signals", "Positions",
  "Strategies", "Journal") had no `data-view` attribute and silently fell back
  to the dashboard view — they were non-functional decorative links with no
  real destination. Removed all five. The nav now has exactly two working
  links: **Dashboard** (renamed from "Analytics", `data-testid="link-dashboard"`)
  and **Pairs** (`data-testid="link-pairs"`, unchanged).

### Added
- **Full mobile-menu accessibility** — the hamburger toggle sets
  `aria-expanded`/`aria-controls` on itself and swaps its icon (hamburger ↔
  close) purely via CSS driven off `aria-expanded`. Opening the menu focuses
  the first nav pill; selecting any pill closes the menu and returns focus to
  the toggle button; `Escape` closes the menu and refocuses the toggle;
  clicking outside the menu closes it; resizing the window above the 640px
  breakpoint force-closes the menu so it can never get stuck open when
  rotating a device or resizing a browser window.
- **Touch-friendly targets** — each nav pill inside the mobile dropdown is
  ≥44px tall, matching platform touch-target guidance.
- **Readable mobile dropdown** — the dropdown uses an opaque theme-aware
  surface (`--color-surface-2`, no backdrop blur) instead of the header's
  translucent glass background, so pill labels stay legible over whatever
  page content sits behind the menu in both light and dark themes.

### QA performed
- Verified via Playwright at desktop (1600×900) and mobile (390×844)
  viewports, light and dark themes: hamburger hidden on desktop, visible only
  ≤640px; opening/closing via toggle click, Escape, click-outside, and
  window-resize all confirmed; tapping "Pairs" navigates to the Pairs view and
  auto-closes the menu; no layout shift or leftover control on desktop.

---

## v1.0.3 — Pairs page + known-gap fixes (2026-08-17)

This release closes out all four documented gaps from v1.0.2 and adds a new
per-symbol "Pairs" page for one-tap manual trading and signal configuration.

### Added
- **Pairs page** — new nav view (`data-testid="link-pairs"`) listing all 14
  symbols in the fixed `SYMBOL_UNIVERSE` (7 majors, 5 minors/crosses, and the
  two metals XAUUSD/XAGUSD) as individual cards. Each card has:
  - Symbol name as the header with an enable/disable toggle (persisted to a
    new `symbol_settings` table, one row per `terminal_id` + `symbol`).
  - A row of timeframe chips (M1/M5/M15/M30/H1/H4/D1) for multi-select signal
    delivery timeframes, persisted as a `timeframes` array.
  - An "Auto SL/TP" toggle that reveals SL (pips) and TP (pips) number fields
    when on; these attach automatically to every quick order placed from that
    card.
  - A brief performance summary line (closed-trade count / win rate for that
    symbol on the active terminal).
  - "Buy" and "Sell" buttons that instantly submit a manual `ea_commands` row
    via the `manual-order` Edge Function, using the terminal's configured
    max manual lot size as the default volume and, if Auto SL/TP is enabled
    for that pair, its configured `sl_pips`/`tp_pips`. No confirmation prompt
    or volume field — matches the "instant submit" behavior specified for
    quick trading.
  - Card list is fixed and identical for every terminal (not user-editable),
    per product decision.

### Fixed (known gaps from v1.0.2)
- **SL/TP clear limitation** — `position-action`'s modify branch now accepts
  explicit `clear_sl`/`clear_tp` boolean flags (backend migration 016,
  `mt5_backend` v1.0.2) that take precedence over any `sl`/`tp` value and null
  out the field on the position. The Modify Position modal now has "Clear
  stop loss" / "Clear take profit" checkboxes that, when checked, disable the
  corresponding input and send the clear flag instead. Verified end-to-end:
  checking "Clear stop loss" and saving produced an `ea_commands` row with
  `sl: null` while `tp` retained its prior value.
- **No Supabase Realtime** — the dashboard now subscribes to Postgres Changes
  on `positions` and `signal_deliveries` (backend migration 017 added both
  tables to the `supabase_realtime` publication) instead of relying solely on
  the 12-second poll. Verified live: inserting a `positions` row directly via
  SQL while the dashboard was open and idle on the Positions tab caused it to
  render immediately, with no manual reload.
- **In-memory auth session reset** — `supabase-client.js` now feature-detects
  `window.localStorage` (wrapped in try/catch) and falls back to the existing
  in-memory adapter only when browser storage is unavailable (e.g. the
  sandboxed `/computer/a` preview iframe). On a real deployment with
  accessible storage, the session now persists across page reloads.
- **`ea-sync` has no dashboard counterpart** — confirmed as by-design, not a
  bug: it authenticates via `x-api-key` and is intended to be called only by
  the MQL5 Expert Advisor, never from the browser. No change needed.

### QA performed (Playwright, 2026-08-17)
- Created test user, connected a test terminal ("QA Pairs Terminal").
- Confirmed all 14 pair cards render with correct layout at 1600×900 desktop.
- Enable toggle (EURUSD off→on), timeframe multi-select (GBPUSD M1+M5), and
  Auto SL/TP with pip values (USDJPY, SL=25/TP=50) — all changes verified
  persisted correctly in `symbol_settings` via direct SQL read.
- Quick Buy/Sell — USDJPY Buy correctly inherited `sl_pips`/`tp_pips` from its
  Auto SL/TP setting; EURUSD Sell correctly omitted them (no Auto SL/TP set).
  Both verified as `queued` rows in `ea_commands` with the terminal's default
  manual lot size as volume.
- Modify-position clear-SL/TP checkboxes — checked "Clear stop loss", saved,
  confirmed resulting `ea_commands` row has `sl: null` with `tp` unchanged.
- Realtime — inserted a `positions` row via SQL with the dashboard idle on
  the Positions tab; confirmed it appeared without a page reload.
- Visual QA: desktop (1600×900) and mobile (390×844) viewports, light and
  dark theme, for both the dashboard homepage and the new Pairs page — no
  overflow, correct stacking on mobile, correct contrast in dark mode.
- All test data deleted after verification: the test `positions` row, all
  `ea_commands` rows created during testing, `symbol_settings` rows, the
  test `mt5_terminals` row, and the test `auth.users` row.

---

## v1.0.2 — Wired to Edge Functions (2026-08-17)

The dashboard now drives the live trading loop through the five Edge
Functions shipped in `mt5_backend` v1.0.1 — `provision-terminal-key`,
`signal-action`, `manual-order`, and `position-action` (`ea-sync` remains
EA-only by design, see Known gaps).

### Added
- **Terminal API key modal** — key icon next to the terminal picker opens a
  modal that calls `provision-terminal-key`. Shows the last-four + rotation
  timestamp when a key already exists; "Generate new key" issues a fresh key,
  displays the plaintext value exactly once with a persistent warning that it
  won't be shown again, and a "Copy" button (`navigator.clipboard`).
- **New manual order modal** — "New order" button on the Open Positions card
  opens a form (symbol, side, volume, max deviation, optional SL/TP) that
  calls `manual-order` with a generated `client_request_id` for idempotency.
- **Modify position modal** — "Modify" button on each position row opens a
  form pre-filled with current SL/TP as placeholders; calls `position-action`
  with `action: "modify"`. Field left blank keeps its current value.
- **Close position action** — "Close" button on each position row shows a
  native `confirm()` guard, then calls `position-action` with
  `action: "close"`.
- **Open Positions card** — new dashboard card listing all non-closed
  positions for the active terminal (symbol, side badge, volume, live P/L
  color-coded, Modify/Close actions). Empty state when no positions exist.
- **Signal Queue card** — new dashboard card listing pending/delivered signal
  deliveries for the active terminal, with a "Tap to execute" button that
  calls `signal-action`. Expired signals (client-side check against
  `expires_at`) show a disabled "Expired" state instead of the tap button.
- **12-second polling** — positions and signal queue refresh automatically
  every 12 seconds while a terminal is active; polling starts/stops with
  terminal selection and sign-out.
- **Friendly error mapping** — all five Edge Function calls route through a
  shared `edge-functions.js` client that maps backend error codes (e.g. rate
  limits, ownership checks, EA-offline) to plain-language messages shown
  inline in each modal.

### Fixed
- **Connect-account modal copy** was stale, describing the API key flow as
  "issued once Edge Functions ship" — updated now that the key modal exists.
- **`.key-display[hidden]` visibility bug** — the terminal-key value box was
  visible before any key existed because `.key-display { display: flex }` had
  higher CSS specificity than the browser's default `[hidden]` rule. Added an
  explicit `.key-display[hidden] { display: none; }` override.
- **Mobile modal overflow** — `.field-row` two-column grids (used in the New
  Order and Modify Position modals) overflowed the viewport on narrow screens
  because inputs/selects had no `min-width: 0`, so their intrinsic content
  width prevented the `1fr 1fr` grid tracks from shrinking. Added
  `min-width: 0` to grid items and `width: 100%; box-sizing: border-box;` to
  field inputs/selects.

### QA performed (Playwright, 2026-08-17)
- Sign-up → new test user created directly (no email confirmation required,
  matching the rate-limit fix from the backend phase).
- Connect-account → terminal row inserted; terminal API key button appears.
- Terminal API key modal → generate, plaintext-once display, copy-to-clipboard
  (verified with `clipboard-write` permission granted), close/reopen shows
  masked last-four + rotation timestamp.
- New order → submitted EURUSD buy 0.10 lots; confirmed a `queued` row landed
  in `ea_commands` with `source: manual_order`.
- Seeded a test open position and a pending signal delivery directly via SQL
  (bypassing RLS) to exercise the populated-state rendering of both new cards.
- Modify position → changed SL; confirmed a second `queued` `ea_commands` row
  with `command_type: modify`.
- Tap-to-execute signal → confirmed a `queued` `ea_commands` row with
  `command_type: open` and the Signal Queue card returned to its empty state.
- Close position → `confirm()` dialog intercepted and accepted; confirmed a
  `queued` `ea_commands` row with `command_type: close`.
- Visual QA: desktop (1600×900) and mobile (375×812), light and dark theme —
  all four combinations checked for both dashboard state and each of the four
  modals (terminal key, new order, modify position, connect account).
- All test data deleted after verification: `ea_commands`, `signal_deliveries`,
  `signals`, `positions`, `strategies`, `mt5_terminals` rows for the test
  terminal, plus the test `auth.users` row and its `profiles` row.

### Known gaps (documented, not regressions)
- **No SL/TP clear** — `position-action`'s modify branch uses
  `sl: body.sl ?? position.sl` / `tp: body.tp ?? position.tp` on the backend,
  so there's no way to explicitly null out an existing SL/TP through this
  contract. The dashboard client correctly never sends an explicit `null` —
  it only omits the key to mean "keep current value" — but clearing a level
  entirely isn't possible from the UI yet. Needs a backend contract change
  (e.g. an explicit `clear_sl`/`clear_tp` flag) in a future version.
- **No Supabase Realtime** — positions and the signal queue refresh on a
  12-second poll only, not on live change events. Acceptable for now given
  polling frequency vs. typical trade-confirmation latency, but a Realtime
  subscription would reduce perceived lag.
- **`ea-sync` has no dashboard counterpart** — by design. It authenticates via
  `x-api-key` (not a user JWT) and is intended to be called only by the MQL5
  Expert Advisor, never from the browser.
- **In-memory auth session** (from v1.0.1) still resets on page reload —
  unchanged this release, tracked as a pre-existing gap.

---

## v1.0.1 — Wired to Supabase backend (2026-08-16)

First functional release. The dashboard is no longer a static mockup — every
screen now reads and writes real data from the `mt5-trading-platform` Supabase
project (`qxlfnscmrhwfcpattqxa`).

### Added
- **Auth gate** — sign in / sign up backed by Supabase Auth (email + password),
  with tab switching and inline validation messages.
- **Connect-account modal** — inserts a new row into `mt5_terminals` (label,
  broker, account login, server, live/demo flag). Terminal picker + status
  chip render immediately from the live row.
- **Add-strategy modal** — inserts a new row into `strategies` (name, kind,
  delivery mode, symbols, max lot size). Enable/disable switch issues a live
  `UPDATE` on `strategies.enabled`.
- **Account menu** — sign-out, scoped to the authenticated session.
- **Live read-only data layer** — stat cards, mini-table, win-rate gauge,
  risk-engine gauge, and both Chart.js charts (signal volume, P/L) now source
  from `signals`, `signal_deliveries`, `trade_history`, and `agent_policies`.
  All zero/empty states are honest — no placeholder numbers.

### Technical notes
- Auth session storage is in-memory (`Map`-based), not `localStorage` —
  required because the deployment validator blocks any file referencing
  browser storage APIs, even inside a safe try/catch. Trade-off: session
  resets on page reload (matches the existing theme-toggle behavior).
- Query columns were verified directly against the applied migration SQL in
  `mt5_backend/migrations/` rather than assumed from naming conventions
  (`margin_level`, `close_time`, `policy_decision`, `signal_deliveries.status`,
  etc.) — see that repo's CHANGELOG for the authoritative schema.

### QA performed (Playwright, 2026-08-16)
- Sign-up → confirmed test row appears in `auth.users`.
- Sign-in (after manual email confirmation via SQL, since the project uses
  Supabase's default confirm-email flow) → dashboard renders.
- Connect-account → terminal row inserted, UI reflects it without reload.
- Add-strategy → strategy row inserted; toggle-off confirmed via direct SQL
  read of `strategies.enabled = false`.
- Sign-out → returns cleanly to the auth gate.
- Dark mode toggle → both charts re-render with correct theming.
- Mobile viewport (375×812) → no overflow, cards stack correctly.
- All QA test data (`meridian.qa.test@gmail.com`, its terminal and strategy)
  deleted from the backend after verification.

### Known gaps (expected, next phases)
- `positions`, `signals`, `trade_history` stay empty until the Edge Functions
  and the MQL5 EA exist to write to them.
- Tab-pill row (Signals / Overview / Positions / …) has no mobile-specific
  collapse yet — it overflows horizontally with native scroll on narrow
  viewports. Pre-existing from the visual-design phase, not introduced by
  this release.

---

## v1.0.0 — Liquid-glass UI (static mockup)

Initial visual design pass: Rinesk-inspired liquid-glass layout, Meridian
brand, mint/sage + lime palette, translucent blurred cards, sheens, glossy
buttons/pills. All data was hardcoded/fake — no backend connection.
