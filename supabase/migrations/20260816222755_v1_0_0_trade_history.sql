create table public.trade_history (
  id uuid primary key default gen_random_uuid(),
  terminal_id uuid not null references public.mt5_terminals(id) on delete cascade,
  strategy_id uuid references public.strategies(id) on delete set null,
  mt5_ticket bigint not null,
  symbol text not null,
  side text not null check (side in ('buy', 'sell')),
  volume numeric not null,
  open_price numeric not null,
  close_price numeric not null,
  open_time timestamptz not null,
  close_time timestamptz not null,
  profit numeric not null,
  r_multiple numeric,
  session text check (session in ('asia', 'london', 'ny', 'overlap')),
  htf_regime text check (htf_regime in ('trending', 'ranging')),
  near_news_event boolean not null default false,
  news_event_id uuid references public.calendar_events(id) on delete set null,
  source text not null default 'manual_order'
    check (source in ('auto_signal', 'manual_tap', 'manual_order')),
  outcome text not null check (outcome in ('win', 'loss', 'breakeven')),
  created_at timestamptz not null default now(),
  unique (terminal_id, mt5_ticket)
);

create index idx_trade_history_terminal_id on public.trade_history(terminal_id);
create index idx_trade_history_scenario
  on public.trade_history(terminal_id, strategy_id, symbol, session, htf_regime, near_news_event);
create index idx_trade_history_close_time on public.trade_history(close_time);
;
