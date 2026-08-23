create table public.positions (
  id uuid primary key default gen_random_uuid(),
  terminal_id uuid not null references public.mt5_terminals(id) on delete cascade,
  strategy_id uuid references public.strategies(id) on delete set null,
  mt5_ticket bigint not null,
  symbol text not null,
  side text not null check (side in ('buy', 'sell')),
  volume numeric not null,
  open_price numeric not null,
  current_price numeric,
  sl numeric,
  tp numeric,
  unrealized_pl numeric,
  source text not null default 'manual_order'
    check (source in ('auto_signal', 'manual_tap', 'manual_order')),
  status text not null default 'open'
    check (status in ('open', 'closing', 'closed')),
  open_time timestamptz not null,
  updated_at timestamptz not null default now(),
  unique (terminal_id, mt5_ticket)
);

create index idx_positions_terminal_id on public.positions(terminal_id);
create index idx_positions_status on public.positions(status) where status != 'closed';

create trigger trg_positions_updated_at
  before update on public.positions
  for each row execute function public.set_updated_at();
;
