create table public.scenario_stats (
  id uuid primary key default gen_random_uuid(),
  terminal_id uuid not null references public.mt5_terminals(id) on delete cascade,
  strategy_id uuid not null references public.strategies(id) on delete cascade,
  symbol text not null,
  session text not null check (session in ('asia', 'london', 'ny', 'overlap')),
  htf_regime text not null check (htf_regime in ('trending', 'ranging')),
  near_news_event boolean not null default false,
  trade_count int not null default 0,
  win_count int not null default 0,
  raw_win_rate numeric,
  shrunk_win_rate numeric,
  recency_weighted_win_rate numeric,
  avg_r_multiple numeric,
  computed_at timestamptz not null default now(),
  unique (terminal_id, strategy_id, symbol, session, htf_regime, near_news_event)
);

create table public.agent_policies (
  id uuid primary key default gen_random_uuid(),
  terminal_id uuid not null references public.mt5_terminals(id) on delete cascade,
  strategy_id uuid not null references public.strategies(id) on delete cascade,
  symbol text not null,
  session text not null check (session in ('asia', 'london', 'ny', 'overlap')),
  htf_regime text not null check (htf_regime in ('trending', 'ranging')),
  near_news_event boolean not null default false,
  decision text not null default 'ok' check (decision in ('ok', 'downweight', 'block')),
  downweight_factor numeric not null default 1.0,
  reason text,
  scenario_stats_id uuid references public.scenario_stats(id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (terminal_id, strategy_id, symbol, session, htf_regime, near_news_event)
);

create index idx_scenario_stats_terminal_id on public.scenario_stats(terminal_id);
create index idx_agent_policies_lookup
  on public.agent_policies(terminal_id, strategy_id, symbol, session, htf_regime, near_news_event);

create trigger trg_agent_policies_updated_at
  before update on public.agent_policies
  for each row execute function public.set_updated_at();
;
