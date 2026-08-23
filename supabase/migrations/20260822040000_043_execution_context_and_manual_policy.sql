-- v1.0.21 — immutable entry context for every economic MT5 position.
-- Context is captured at entry and copied to the final analytical trade so
-- later edits/deletions to strategies or calendar data cannot rewrite history.

alter table public.ea_commands
  add column if not exists strategy_name_at_entry text,
  add column if not exists origin_detail text,
  add column if not exists risk_defined boolean not null default false,
  add column if not exists entry_context jsonb not null default '{}'::jsonb;

alter table public.positions
  add column if not exists strategy_name_at_entry text,
  add column if not exists origin_detail text,
  add column if not exists risk_defined boolean not null default false,
  add column if not exists entry_context jsonb not null default '{}'::jsonb;

alter table public.trade_history
  add column if not exists strategy_name_at_entry text,
  add column if not exists origin_detail text,
  add column if not exists risk_defined boolean not null default false,
  add column if not exists entry_context jsonb not null default '{}'::jsonb,
  add column if not exists net_profit numeric;

create index if not exists idx_trade_history_origin_detail
  on public.trade_history (terminal_id, origin_detail, close_time desc);

comment on column public.ea_commands.entry_context is
  'Immutable market/decision snapshot at entry: requested and fill timestamps, session, regime model/version, news context, strategy/playbook snapshot and execution intent.';
comment on column public.positions.entry_context is
  'Copy of the originating open command context, or a captured MT5-direct context when no command exists.';
comment on column public.trade_history.entry_context is
  'Immutable entry context copied from positions at close; analytics must use this rather than mutable strategy configuration.';
comment on column public.trade_history.net_profit is
  'Realized account-currency P/L inclusive of deal profit, commission, swap and fees when MT5 deal data is available.';
