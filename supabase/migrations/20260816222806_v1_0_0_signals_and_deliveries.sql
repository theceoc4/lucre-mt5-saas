create table public.signals (
  id uuid primary key default gen_random_uuid(),
  terminal_id uuid not null references public.mt5_terminals(id) on delete cascade,
  strategy_id uuid not null references public.strategies(id) on delete cascade,
  symbol text not null,
  side text not null check (side in ('buy', 'sell')),
  suggested_volume numeric not null,
  suggested_sl numeric,
  suggested_tp numeric,
  entry_price_ref numeric not null,
  session text check (session in ('asia', 'london', 'ny', 'overlap')),
  htf_regime text check (htf_regime in ('trending', 'ranging')),
  near_news_event boolean not null default false,
  news_event_id uuid references public.calendar_events(id) on delete set null,
  score numeric,
  policy_decision text not null default 'ok'
    check (policy_decision in ('ok', 'downweight', 'block')),
  ttl_seconds int not null default 60,
  generated_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index idx_signals_terminal_id on public.signals(terminal_id);
create index idx_signals_generated_at on public.signals(generated_at);

create table public.signal_deliveries (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid not null unique references public.signals(id) on delete cascade,
  terminal_id uuid not null references public.mt5_terminals(id) on delete cascade,
  delivery_mode text not null check (delivery_mode in ('auto', 'manual_confirm')),
  status text not null default 'pending'
    check (status in ('pending', 'delivered', 'tapped', 'auto_executed', 'expired', 'cancelled', 'failed')),
  delivered_at timestamptz,
  acted_at timestamptz,
  ea_command_id uuid,
  created_at timestamptz not null default now()
);

create index idx_signal_deliveries_terminal_id on public.signal_deliveries(terminal_id);
create index idx_signal_deliveries_status on public.signal_deliveries(status)
  where status in ('pending', 'delivered');
;
