# Database Schema Snapshot

This is a **live introspection snapshot** taken from the running Supabase
project (`qxlfnscmrhwfcpattqxa`) — not a replay of historical migration files.
Supabase's `list_migrations` only stores migration version + name metadata,
not the original SQL bodies, so the per-migration `.sql` history could not be
reconstructed. Migration names/order are preserved in `migrations.md` for context.

Going forward, every new migration applied to this project should also be
committed to `migrations/` in this repo (see that folder's README) so future
snapshots don't have this gap.

## Tables (public schema)

### `public.profiles`

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| id | uuid | no |  |  |
| display_name | text | no |  |  |
| created_at | timestamptz | no | now() |  |
| updated_at | timestamptz | no | now() |  |

Primary key: id

### `public.mt5_terminals`

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| id | uuid | no | gen_random_uuid() |  |
| user_id | uuid | no |  |  |
| label | text | no |  |  |
| broker | text | no |  |  |
| account_login | text | no |  |  |
| server | text | no |  |  |
| is_live | bool | no | true |  |
| api_key_hash | text | no |  |  |
| api_key_last_four | text | no |  |  |
| status | text | no | 'disconnected'::text |  |
| last_heartbeat_at | timestamptz | no |  |  |
| equity | numeric | no |  |  |
| balance | numeric | no |  |  |
| margin_level | numeric | no |  |  |
| created_at | timestamptz | no | now() |  |
| updated_at | timestamptz | no | now() |  |
| max_manual_lot_size | numeric | no | 0.10 |  |
| max_daily_loss_usd | numeric | no | 500 |  |
| max_open_positions | int4 | no | 5 |  |
| api_key_last_rotated_at | timestamptz | no |  |  |
| margin_mode | text | no |  |  |
| broker_regulatory_class | text | no | 'unknown'::text |  |
| allow_long | bool | no | true |  |
| allow_short | bool | no | true |  |
| daily_profit_target_pct | numeric | no |  |  |
| risk_appetite | text | no | 'balanced'::text |  |
| hedging_enabled | bool | no | false |  |
| hedge_trigger_drawdown_pct | numeric | no | 0.5 |  |
| basket_profit_lock_pct | numeric | no | 0.15 |  |
| max_basket_exposure_lots | numeric | no |  |  |
| max_hedge_layers | int4 | no | 3 |  |
| max_basket_drawdown_pct | numeric | no | 3.0 |  |
| auto_trading_enabled | bool | no | true |  |
| force_symbol_rescan | bool | no | false |  |
| last_symbol_scan_at | timestamptz | no |  |  |

Primary key: id

### `public.strategies`

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| id | uuid | no | gen_random_uuid() |  |
| terminal_id | uuid | no |  |  |
| name | text | no |  |  |
| kind | text | no |  |  |
| symbols | _text | no | '{}'::text[] |  |
| enabled | bool | no | false |  |
| delivery_mode | text | no | 'manual_confirm'::text |  |
| max_lot_size | numeric | no | 0.01 |  |
| signal_ttl_seconds | int4 | no | 60 |  |
| config | jsonb | no | '{}'::jsonb |  |
| created_at | timestamptz | no | now() |  |
| updated_at | timestamptz | no | now() |  |
| signal_family | text | no |  |  |
| allow_long | bool | no |  |  |
| allow_short | bool | no |  |  |
| news_posture | text | no | 'avoid'::text |  |
| news_window_minutes | int4 | no | 30 |  |
| news_min_impact | text | no | 'medium'::text |  |
| news_exploit_size_multiplier | numeric | no | 1.5 |  |

Primary key: id

### `public.positions`

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| id | uuid | no | gen_random_uuid() |  |
| terminal_id | uuid | no |  |  |
| strategy_id | uuid | no |  |  |
| mt5_ticket | int8 | no |  |  |
| symbol | text | no |  |  |
| side | text | no |  |  |
| volume | numeric | no |  |  |
| open_price | numeric | no |  |  |
| current_price | numeric | no |  |  |
| sl | numeric | no |  |  |
| tp | numeric | no |  |  |
| unrealized_pl | numeric | no |  |  |
| source | text | no | 'manual_order'::text |  |
| status | text | no | 'open'::text |  |
| open_time | timestamptz | no |  |  |
| updated_at | timestamptz | no | now() |  |
| basket_state_id | uuid | no |  |  |
| is_hedge | bool | no | false |  |
| hedge_layer | int4 | no |  |  |
| closing_since | timestamptz | no |  |  |

Primary key: id

### `public.calendar_events`

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| id | uuid | no | gen_random_uuid() |  |
| event_time | timestamptz | no |  |  |
| country | text | no |  |  |
| impact | text | no |  |  |
| title | text | no |  |  |
| affected_symbols | _text | no | '{}'::text[] |  |
| created_at | timestamptz | no | now() |  |
| currency | text | no |  |  |
| forecast | numeric | no |  |  |
| previous | numeric | no |  |  |
| actual | numeric | no |  |  |
| higher_is_bullish | bool | no |  |  |
| source | text | no | 'manual'::text |  |
| mql5_event_id | int8 | no |  |  |
| mql5_value_id | int8 | no |  |  |
| is_global | bool | no | false |  |

Primary key: id

### `public.trade_history`

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| id | uuid | no | gen_random_uuid() |  |
| terminal_id | uuid | no |  |  |
| strategy_id | uuid | no |  |  |
| mt5_ticket | int8 | no |  |  |
| symbol | text | no |  |  |
| side | text | no |  |  |
| volume | numeric | no |  |  |
| open_price | numeric | no |  |  |
| close_price | numeric | no |  |  |
| open_time | timestamptz | no |  |  |
| close_time | timestamptz | no |  |  |
| profit | numeric | no |  |  |
| r_multiple | numeric | no |  |  |
| session | text | no |  |  |
| htf_regime | text | no |  |  |
| near_news_event | bool | no | false |  |
| news_event_id | uuid | no |  |  |
| source | text | no | 'manual_order'::text |  |
| outcome | text | no |  |  |
| created_at | timestamptz | no | now() |  |
| close_reason | text | no |  |  |
| basket_state_id | uuid | no |  |  |
| is_hedge | bool | no | false |  |
| hedge_layer | int4 | no |  |  |
| profit_verified | bool | no | true |  |

Primary key: id

### `public.signals`

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| id | uuid | no | gen_random_uuid() |  |
| terminal_id | uuid | no |  |  |
| strategy_id | uuid | no |  |  |
| symbol | text | no |  |  |
| side | text | no |  |  |
| suggested_volume | numeric | no |  |  |
| suggested_sl | numeric | no |  |  |
| suggested_tp | numeric | no |  |  |
| entry_price_ref | numeric | no |  |  |
| session | text | no |  |  |
| htf_regime | text | no |  |  |
| near_news_event | bool | no | false |  |
| news_event_id | uuid | no |  |  |
| score | numeric | no |  |  |
| policy_decision | text | no | 'ok'::text |  |
| ttl_seconds | int4 | no | 60 |  |
| generated_at | timestamptz | no | now() |  |
| expires_at | timestamptz | no |  |  |

Primary key: id

### `public.signal_deliveries`

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| id | uuid | no | gen_random_uuid() |  |
| signal_id | uuid | no |  |  |
| terminal_id | uuid | no |  |  |
| delivery_mode | text | no |  |  |
| status | text | no | 'pending'::text |  |
| delivered_at | timestamptz | no |  |  |
| acted_at | timestamptz | no |  |  |
| ea_command_id | uuid | no |  |  |
| created_at | timestamptz | no | now() |  |

Primary key: id

### `public.ea_commands`

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| id | uuid | no | gen_random_uuid() |  |
| terminal_id | uuid | no |  |  |
| source | text | no |  |  |
| command_type | text | no |  |  |
| symbol | text | no |  |  |
| side | text | no |  |  |
| volume | numeric | no |  |  |
| sl | numeric | no |  |  |
| tp | numeric | no |  |  |
| mt5_ticket | int8 | no |  |  |
| max_deviation_points | int4 | no | 20 |  |
| idempotency_key | text | no |  |  |
| status | text | no | 'queued'::text |  |
| signal_delivery_id | uuid | no |  |  |
| error_message | text | no |  |  |
| requested_at | timestamptz | no | now() |  |
| executed_at | timestamptz | no |  |  |
| session | text | no |  |  |
| htf_regime | text | no |  |  |
| near_news_event | bool | no | false |  |
| news_event_id | uuid | no |  |  |
| sl_pips | numeric | no |  |  |
| tp_pips | numeric | no |  |  |
| strategy_id | uuid | no |  |  |
| sweep_attempts | int4 | no | 0 |  |

Primary key: id

### `public.scenario_stats`
_The learning grid: one row per (terminal, strategy, symbol, session, htf_regime, near_news_event) cell, rebuilt by the nightly batch job / close-triggered recompute (Phase 4, not yet built). Win-rate columns (raw/shrunk/recency_weighted) are DISPLAY/context metrics only. The adaptive throttle engine (architecture spec v0.2 section 9.2) and agent_policies decisions must be driven by profit_factor and expectancy_per_trade/avg_r_multiple -- a strategy can be profitable at a 30% win rate (small losses, large wins) and unprofitable at a 70% win rate (large losses, small wins), so win rate alone must never gate a block/downweight decision._

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| id | uuid | no | gen_random_uuid() |  |
| terminal_id | uuid | no |  |  |
| strategy_id | uuid | no |  |  |
| symbol | text | no |  |  |
| session | text | no |  |  |
| htf_regime | text | no |  |  |
| near_news_event | bool | no | false |  |
| trade_count | int4 | no | 0 |  |
| win_count | int4 | no | 0 |  |
| raw_win_rate | numeric | no |  |  |
| shrunk_win_rate | numeric | no |  |  |
| recency_weighted_win_rate | numeric | no |  |  |
| avg_r_multiple | numeric | no |  |  |
| computed_at | timestamptz | no | now() |  |
| gross_profit | numeric | no | 0 |  |
| gross_loss | numeric | no | 0 |  |
| profit_factor | numeric | no |  |  |
| expectancy_per_trade | numeric | no |  |  |

Primary key: id

### `public.agent_policies`

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| id | uuid | no | gen_random_uuid() |  |
| terminal_id | uuid | no |  |  |
| strategy_id | uuid | no |  |  |
| symbol | text | no |  |  |
| session | text | no |  |  |
| htf_regime | text | no |  |  |
| near_news_event | bool | no | false |  |
| decision | text | no | 'ok'::text |  |
| downweight_factor | numeric | no | 1.0 |  |
| reason | text | no |  |  |
| scenario_stats_id | uuid | no |  |  |
| updated_at | timestamptz | no | now() |  |
| decided_by | text | no | 'auto_throttle'::text |  |
| auto_tier | int4 | no |  |  |
| auto_decision | text | no |  |  |
| auto_downweight_factor | numeric | no |  |  |
| auto_computed_at | timestamptz | no |  |  |
| cooldown_until | timestamptz | no |  |  |

Primary key: id

### `public.symbol_settings`
_Dashboard-only per-terminal pair preferences (enabled, timeframes, auto SL/TP defaults). Not read by the EA -- signal-engine/strategy wiring to consume timeframes/enabled is tracked as follow-up work._

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| id | uuid | no | gen_random_uuid() |  |
| terminal_id | uuid | no |  |  |
| symbol | text | no |  |  |
| enabled | bool | no | true |  |
| timeframes | _text | no | '{}'::text[] |  |
| auto_sl_tp_enabled | bool | no | false |  |
| auto_sl_pips | numeric | no |  |  |
| auto_tp_pips | numeric | no |  |  |
| created_at | timestamptz | no | now() |  |
| updated_at | timestamptz | no | now() |  |

Primary key: id

### `public.basket_state`
_Single upserted row per terminal tracking the current basket state machine position (flat/building/monitoring/defending/harvesting). basket_events is the append-only log of transitions; this is the current snapshot the dashboard subscribes to over Realtime._

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| id | uuid | no | gen_random_uuid() |  |
| terminal_id | uuid | no |  |  |
| status | text | no | 'flat'::text |  |
| combined_floating_pl | numeric | no | 0 |  |
| combined_lots_long | numeric | no | 0 |  |
| combined_lots_short | numeric | no | 0 |  |
| open_position_count | int4 | no | 0 |  |
| hedge_layer_count | int4 | no | 0 |  |
| entered_defending_at | timestamptz | no |  |  |
| day_realized_pl | numeric | no | 0 |  |
| day_start_balance | numeric | no |  |  |
| updated_at | timestamptz | no | now() |  |

Primary key: id

### `public.basket_events`
_Append-only audit log of basket_state transitions, one row per event. detail carries event-specific context (e.g. drawdown_pct at trigger time, hedge position id, lock price)._

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| id | uuid | no | gen_random_uuid() |  |
| basket_state_id | uuid | no |  |  |
| terminal_id | uuid | no |  |  |
| event_type | text | no |  |  |
| detail | jsonb | no | '{}'::jsonb |  |
| created_at | timestamptz | no | now() |  |

Primary key: id

### `public.hedge_links`
_One row per position that participates in a basket hedge. hedge_role primary is the original signal leg being defended; hedge is the opposing/correlated leg opened to offset it. hedge_symbol_group is the correlation cluster (from symbol_correlations) used to pick the hedge instrument on netting/FIFO accounts where the same symbol cannot be hedged directly._

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| position_id | uuid | no |  |  |
| basket_state_id | uuid | no |  |  |
| hedge_layer | int4 | no |  |  |
| hedge_role | text | no |  |  |
| hedge_symbol_group | text | no |  |  |
| opposing_position_id | uuid | no |  |  |
| created_at | timestamptz | no | now() |  |

Primary key: position_id

### `public.symbol_correlations`
_Rolling correlation (default 20-day, refreshed daily by a scheduled job) between symbol pairs, used by the basket manager to pick a correlated hedge instrument when the account cannot hedge the same symbol directly (netting/FIFO accounts). Global reference data, not scoped to a terminal._

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| symbol_a | text | no |  |  |
| symbol_b | text | no |  |  |
| timeframe | text | no |  |  |
| correlation | numeric | no |  |  |
| computed_at | timestamptz | no | now() |  |

Primary key: symbol_a, symbol_b, timeframe

### `public.daily_performance`
_One row per terminal per UTC trading day, upserted throughout the day as positions close. hit_daily_target/hit_daily_max_loss flip the dynamic sizing state machine (§7.2) into its reduced-risk or paused-for-the-day state; daily_profit_target_pct/max_daily_loss_usd on mt5_terminals are the thresholds compared against._

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| terminal_id | uuid | no |  |  |
| trading_day | date | no |  |  |
| realized_pl | numeric | no | 0 |  |
| floating_pl_eod | numeric | no |  |  |
| trades_count | int4 | no | 0 |  |
| max_intraday_drawdown_pct | numeric | no |  |  |
| hit_daily_target | bool | no | false |  |
| hit_daily_max_loss | bool | no | false |  |
| created_at | timestamptz | no | now() |  |
| updated_at | timestamptz | no | now() |  |

Primary key: terminal_id, trading_day

### `public.symbol_mappings`
_One row per (terminal, canonical_symbol) mapping the dashboard/signal-generation canonical name to this specific broker's actual symbol string. Populated by report-symbols; consumed by manual-order and signal-action before every ea_commands insert._

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| id | uuid | no | gen_random_uuid() |  |
| terminal_id | uuid | no |  |  |
| canonical_symbol | text | no |  |  |
| asset_class | text | no |  |  |
| broker_symbol | text | no |  |  |
| match_type | text | no | 'unavailable'::text |  |
| candidates | _text | no | '{}'::text[] |  |
| needs_review | bool | no | false |  |
| last_synced_at | timestamptz | no | now() |  |
| created_at | timestamptz | no | now() |  |
| updated_at | timestamptz | no | now() |  |

Primary key: id

### `public.price_bars`

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| id | uuid | no | gen_random_uuid() |  |
| terminal_id | uuid | no |  |  |
| symbol | text | no |  |  |
| timeframe | text | no | 'M5'::text |  |
| bar_time | timestamptz | no |  |  |
| open | numeric | no |  |  |
| high | numeric | no |  |  |
| low | numeric | no |  |  |
| close | numeric | no |  |  |
| volume | numeric | no | 0 |  |
| created_at | timestamptz | no | now() |  |

Primary key: id
