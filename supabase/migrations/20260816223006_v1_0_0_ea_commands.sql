create table public.ea_commands (
  id uuid primary key default gen_random_uuid(),
  terminal_id uuid not null references public.mt5_terminals(id) on delete cascade,
  source text not null
    check (source in ('auto_signal', 'manual_tap', 'manual_order', 'dashboard_modify', 'dashboard_close')),
  command_type text not null check (command_type in ('open', 'modify', 'close')),
  symbol text,
  side text check (side in ('buy', 'sell')),
  volume numeric,
  sl numeric,
  tp numeric,
  mt5_ticket bigint,
  max_deviation_points int not null default 20,
  idempotency_key text not null,
  status text not null default 'queued'
    check (status in ('queued', 'sent', 'acknowledged', 'executed', 'failed', 'expired')),
  signal_delivery_id uuid references public.signal_deliveries(id) on delete set null,
  error_message text,
  requested_at timestamptz not null default now(),
  executed_at timestamptz,
  unique (terminal_id, idempotency_key)
);

create index idx_ea_commands_terminal_id on public.ea_commands(terminal_id);
create index idx_ea_commands_pending on public.ea_commands(terminal_id, status)
  where status in ('queued', 'sent');

alter table public.signal_deliveries
  add constraint fk_signal_deliveries_ea_command
  foreign key (ea_command_id) references public.ea_commands(id) on delete set null;
;
