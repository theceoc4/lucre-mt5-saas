-- v1.0.26 — compact, versioned trend-strength state for the Pairs dashboard.
-- One mutable row per terminal/symbol keeps Realtime and storage bounded while
-- the closed-candle feed refreshes the score once per minute.

create table public.symbol_trend_state (
  terminal_id uuid not null references public.mt5_terminals(id) on delete cascade,
  symbol text not null,
  score numeric(6,2) not null default 0 check (score between -100 and 100),
  direction text not null default 'neutral'
    check (direction in ('bearish', 'neutral', 'bullish')),
  strength text not null default 'neutral'
    check (strength in ('neutral', 'weak', 'moderate', 'strong')),
  confidence numeric(5,4) not null default 0 check (confidence between 0 and 1),
  regime text not null default 'insufficient_data'
    check (regime in ('trending', 'ranging', 'transition', 'volatility_shock', 'insufficient_data')),
  timeframe_scores jsonb not null default '{}'::jsonb,
  components jsonb not null default '{}'::jsonb,
  source_bar_times jsonb not null default '{}'::jsonb,
  source_bar_time timestamptz,
  model_version text not null default 'trend-strength-v1',
  computed_at timestamptz not null default now(),
  primary key (terminal_id, symbol)
);

create index idx_symbol_trend_state_terminal
  on public.symbol_trend_state (terminal_id, computed_at desc);

-- Internal Wilder/EMA checkpoint. This table is deliberately excluded from
-- Realtime and from authenticated-user grants: it prevents a 160-candle read
-- per symbol every minute while keeping the public state row compact.
create table public.symbol_trend_calculation_state (
  terminal_id uuid not null references public.mt5_terminals(id) on delete cascade,
  symbol text not null,
  timeframe text not null
    check (timeframe in ('M1', 'M5', 'M15', 'H1', 'H4', 'D1')),
  indicator_state jsonb not null,
  timeframe_result jsonb not null,
  source_bar_time timestamptz not null,
  model_version text not null default 'trend-strength-v1',
  updated_at timestamptz not null default now(),
  primary key (terminal_id, symbol, timeframe)
);

create index idx_symbol_trend_calc_terminal_symbol
  on public.symbol_trend_calculation_state (terminal_id, symbol);

comment on table public.symbol_trend_state is
  'Latest layered EMA/RSI/DMI/regime trend-strength result. Operational current state, not a historical signal ledger.';
comment on column public.symbol_trend_state.score is
  'Signed composite meter score from -100 bearish to +100 bullish.';
comment on column public.symbol_trend_state.timeframe_scores is
  'Versioned per-timeframe component state used to update only series whose newest closed candle changed.';

alter table public.symbol_trend_state enable row level security;
alter table public.symbol_trend_calculation_state enable row level security;

create policy "symbol_trend_state_select_own_terminal"
  on public.symbol_trend_state for select to authenticated
  using (exists (
    select 1 from public.mt5_terminals terminal
    where terminal.id = symbol_trend_state.terminal_id
      and terminal.user_id = auth.uid()
  ));

grant select on public.symbol_trend_state to authenticated;
revoke insert, update, delete on public.symbol_trend_state from authenticated;
revoke all on public.symbol_trend_calculation_state from authenticated;
alter publication supabase_realtime add table public.symbol_trend_state;
