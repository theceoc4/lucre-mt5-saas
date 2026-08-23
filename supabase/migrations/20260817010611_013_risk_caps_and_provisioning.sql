alter table public.mt5_terminals
  add column max_manual_lot_size numeric not null default 0.10,
  add column max_daily_loss_usd numeric not null default 500,
  add column max_open_positions int not null default 5,
  add column api_key_last_rotated_at timestamptz;

comment on column public.mt5_terminals.max_manual_lot_size is
  'Ceiling applied to manual dashboard orders that have no strategy context (which would otherwise supply its own max_lot_size).';
comment on column public.mt5_terminals.max_daily_loss_usd is
  'If today''s realized loss on this terminal meets/exceeds this amount, edge functions reject new open commands (manual, tap, and auto) until the next trading day.';
comment on column public.mt5_terminals.max_open_positions is
  'Hard cap on concurrently open positions for this terminal, enforced by edge functions before queuing any new open command.';
comment on column public.mt5_terminals.api_key_last_rotated_at is
  'Set by the provision-terminal-key edge function whenever a new EA connection key is generated for this terminal.';;
