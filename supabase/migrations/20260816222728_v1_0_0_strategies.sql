create table public.strategies (
  id uuid primary key default gen_random_uuid(),
  terminal_id uuid not null references public.mt5_terminals(id) on delete cascade,
  name text not null,
  kind text not null,
  symbols text[] not null default '{}',
  enabled boolean not null default false,
  delivery_mode text not null default 'manual_confirm'
    check (delivery_mode in ('auto', 'manual_confirm')),
  max_lot_size numeric not null default 0.01,
  signal_ttl_seconds int not null default 60,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_strategies_terminal_id on public.strategies(terminal_id);

create trigger trg_strategies_updated_at
  before update on public.strategies
  for each row execute function public.set_updated_at();
;
