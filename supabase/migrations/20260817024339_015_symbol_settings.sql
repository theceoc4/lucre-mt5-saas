create table public.symbol_settings (
  id uuid primary key default gen_random_uuid(),
  terminal_id uuid not null references public.mt5_terminals(id) on delete cascade,
  symbol text not null,
  enabled boolean not null default true,
  timeframes text[] not null default '{}',
  auto_sl_tp_enabled boolean not null default false,
  auto_sl_pips numeric,
  auto_tp_pips numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (terminal_id, symbol),
  constraint symbol_settings_auto_sl_pips_positive check (auto_sl_pips is null or auto_sl_pips > 0),
  constraint symbol_settings_auto_tp_pips_positive check (auto_tp_pips is null or auto_tp_pips > 0)
);

create index idx_symbol_settings_terminal_id on public.symbol_settings(terminal_id);

create trigger trg_symbol_settings_updated_at
  before update on public.symbol_settings
  for each row execute function public.set_updated_at();

comment on table public.symbol_settings is
  'Dashboard-only per-terminal pair preferences (enabled, timeframes, auto SL/TP defaults). Not read by the EA -- signal-engine/strategy wiring to consume timeframes/enabled is tracked as follow-up work.';
comment on column public.symbol_settings.timeframes is
  'Subset of {M1,M5,M15,M30,H1,H4,D1,W1} the user wants signals for on this pair.';
comment on column public.symbol_settings.auto_sl_pips is
  'Default stop-loss distance in pips applied to quick Buy/Sell orders placed from this pair''s card when auto_sl_tp_enabled is true. Sent to manual-order as sl_pips (see migration 016) since the dashboard has no live price feed to compute an absolute price.';
comment on column public.symbol_settings.auto_tp_pips is
  'Same as auto_sl_pips, for take-profit.';

alter table public.symbol_settings enable row level security;

create policy "symbol_settings_all_own_terminal" on public.symbol_settings
  for all to authenticated
  using (exists (
    select 1 from public.mt5_terminals t
    where t.id = symbol_settings.terminal_id and t.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.mt5_terminals t
    where t.id = symbol_settings.terminal_id and t.user_id = auth.uid()
  ));
;
