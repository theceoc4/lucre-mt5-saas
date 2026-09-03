-- Store MT5's account-level floating P/L as the authoritative dashboard value.
-- Per-position profit and swap remain available for reconciliation, but are not
-- assumed to equal the account total on every broker/account configuration.

alter table public.mt5_terminals
  add column if not exists floating_pl numeric,
  add column if not exists account_credit numeric,
  add column if not exists positions_profit numeric,
  add column if not exists positions_swap numeric,
  add column if not exists floating_pl_reported_at timestamptz;

alter table public.positions
  add column if not exists swap numeric not null default 0;

comment on column public.mt5_terminals.floating_pl is
  'Authoritative MT5 ACCOUNT_PROFIT value in the account deposit currency.';
comment on column public.mt5_terminals.account_credit is
  'MT5 ACCOUNT_CREDIT value used to reconcile balance, equity and floating profit.';
comment on column public.mt5_terminals.positions_profit is
  'Diagnostic sum of open POSITION_PROFIT values reported by the EA.';
comment on column public.mt5_terminals.positions_swap is
  'Diagnostic sum of open POSITION_SWAP values reported by the EA.';
comment on column public.mt5_terminals.floating_pl_reported_at is
  'Time the durable ACCOUNT_PROFIT snapshot was accepted from the active EA.';
comment on column public.positions.swap is
  'Current cumulative MT5 POSITION_SWAP for this open position.';
