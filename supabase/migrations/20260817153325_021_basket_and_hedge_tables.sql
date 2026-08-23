create table public.basket_state (
  id uuid primary key default gen_random_uuid(),
  terminal_id uuid not null unique references public.mt5_terminals(id) on delete cascade,
  status text not null default 'flat',
  combined_floating_pl numeric not null default 0,
  combined_lots_long numeric not null default 0,
  combined_lots_short numeric not null default 0,
  open_position_count int not null default 0,
  hedge_layer_count int not null default 0,
  entered_defending_at timestamptz,
  day_realized_pl numeric not null default 0,
  day_start_balance numeric,
  updated_at timestamptz not null default now(),
  constraint basket_state_status_check check (status in (
    'flat', 'building', 'monitoring', 'defending', 'harvesting'
  )),
  constraint basket_state_hedge_layer_count_nonneg check (hedge_layer_count >= 0),
  constraint basket_state_open_position_count_nonneg check (open_position_count >= 0)
);

create trigger trg_basket_state_updated_at
  before update on public.basket_state
  for each row execute function public.set_updated_at();

comment on table public.basket_state is
  'Single upserted row per terminal tracking the current basket state machine position (flat/building/monitoring/defending/harvesting). basket_events is the append-only log of transitions; this is the current snapshot the dashboard subscribes to over Realtime.';
comment on column public.basket_state.status is
  'flat: no open exposure. building: 1+ positions open, no drawdown trigger hit. monitoring: elevated exposure, watching thresholds. defending: hedge_trigger_drawdown_pct breached, hedging eligible. harvesting: basket_profit_lock_pct breached, locking gains.';

alter table public.basket_state enable row level security;

create policy "basket_state_select_own_terminal" on public.basket_state
  for select to authenticated
  using (exists (
    select 1 from public.mt5_terminals t
    where t.id = basket_state.terminal_id and t.user_id = auth.uid()
  ));

create table public.basket_events (
  id uuid primary key default gen_random_uuid(),
  basket_state_id uuid not null references public.basket_state(id) on delete cascade,
  terminal_id uuid not null references public.mt5_terminals(id) on delete cascade,
  event_type text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint basket_events_event_type_check check (event_type in (
    'armed_defending',
    'hedge_opened',
    'profit_locked',
    'flatten_triggered',
    'hard_stop_triggered',
    'exited_defending'
  ))
);

create index idx_basket_events_terminal_id on public.basket_events(terminal_id, created_at desc);
create index idx_basket_events_basket_state_id on public.basket_events(basket_state_id);

comment on table public.basket_events is
  'Append-only audit log of basket_state transitions, one row per event. detail carries event-specific context (e.g. drawdown_pct at trigger time, hedge position id, lock price).';

alter table public.basket_events enable row level security;

create policy "basket_events_select_own_terminal" on public.basket_events
  for select to authenticated
  using (exists (
    select 1 from public.mt5_terminals t
    where t.id = basket_events.terminal_id and t.user_id = auth.uid()
  ));

create table public.hedge_links (
  position_id uuid primary key references public.positions(id) on delete cascade,
  basket_state_id uuid not null references public.basket_state(id) on delete cascade,
  hedge_layer int not null,
  hedge_role text not null,
  hedge_symbol_group text,
  opposing_position_id uuid references public.positions(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint hedge_links_hedge_role_check check (hedge_role in ('primary', 'hedge')),
  constraint hedge_links_hedge_layer_positive check (hedge_layer > 0)
);

create index idx_hedge_links_basket_state_id on public.hedge_links(basket_state_id);

comment on table public.hedge_links is
  'One row per position that participates in a basket hedge. hedge_role primary is the original signal leg being defended; hedge is the opposing/correlated leg opened to offset it. hedge_symbol_group is the correlation cluster (from symbol_correlations) used to pick the hedge instrument on netting/FIFO accounts where the same symbol cannot be hedged directly.';

alter table public.hedge_links enable row level security;

create policy "hedge_links_select_own_terminal" on public.hedge_links
  for select to authenticated
  using (exists (
    select 1 from public.positions p
    join public.mt5_terminals t on t.id = p.terminal_id
    where p.id = hedge_links.position_id and t.user_id = auth.uid()
  ));

create table public.symbol_correlations (
  symbol_a text not null,
  symbol_b text not null,
  timeframe text not null,
  correlation numeric not null,
  computed_at timestamptz not null default now(),
  primary key (symbol_a, symbol_b, timeframe),
  constraint symbol_correlations_correlation_range check (correlation >= -1 and correlation <= 1)
);

comment on table public.symbol_correlations is
  'Rolling correlation (default 20-day, refreshed daily by a scheduled job) between symbol pairs, used by the basket manager to pick a correlated hedge instrument when the account cannot hedge the same symbol directly (netting/FIFO accounts). Global reference data, not scoped to a terminal.';

alter table public.symbol_correlations enable row level security;

create policy "symbol_correlations_select_all" on public.symbol_correlations
  for select to authenticated
  using (true);

create table public.daily_performance (
  terminal_id uuid not null references public.mt5_terminals(id) on delete cascade,
  trading_day date not null,
  realized_pl numeric not null default 0,
  floating_pl_eod numeric,
  trades_count int not null default 0,
  max_intraday_drawdown_pct numeric,
  hit_daily_target boolean not null default false,
  hit_daily_max_loss boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (terminal_id, trading_day),
  constraint daily_performance_trades_count_nonneg check (trades_count >= 0)
);

create index idx_daily_performance_terminal_id on public.daily_performance(terminal_id);

create trigger trg_daily_performance_updated_at
  before update on public.daily_performance
  for each row execute function public.set_updated_at();

comment on table public.daily_performance is
  'One row per terminal per UTC trading day, upserted throughout the day as positions close. hit_daily_target/hit_daily_max_loss flip the dynamic sizing state machine (§7.2) into its reduced-risk or paused-for-the-day state; daily_profit_target_pct/max_daily_loss_usd on mt5_terminals are the thresholds compared against.';

alter table public.daily_performance enable row level security;

create policy "daily_performance_select_own_terminal" on public.daily_performance
  for select to authenticated
  using (exists (
    select 1 from public.mt5_terminals t
    where t.id = daily_performance.terminal_id and t.user_id = auth.uid()
  ));;
