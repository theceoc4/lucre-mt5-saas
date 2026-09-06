-- Strategy-scoped account risk overrides and optional provider-supplied exits.

alter table public.strategies
  add column if not exists override_account_risk boolean not null default false;

comment on column public.strategies.override_account_risk is
  'When true, this strategy bypasses configurable account portfolio limits. Strategy position caps and terminal/broker safety checks remain enforced.';

alter table public.external_signal_events
  add column if not exists source_sl numeric,
  add column if not exists source_tp numeric;

alter table public.external_signal_events
  drop constraint if exists external_signal_events_source_sl_positive,
  add constraint external_signal_events_source_sl_positive check (source_sl is null or source_sl > 0),
  drop constraint if exists external_signal_events_source_tp_positive,
  add constraint external_signal_events_source_tp_positive check (source_tp is null or source_tp > 0);

comment on column public.external_signal_events.source_sl is
  'Optional absolute stop-loss price proposed by an authenticated external provider; direction and distance are revalidated by Lucre.';
comment on column public.external_signal_events.source_tp is
  'Optional absolute take-profit price proposed by an authenticated external provider; direction is revalidated by Lucre.';

create or replace function public.portfolio_risk_gate(
  p_terminal_id uuid,
  p_strategy_id uuid,
  p_symbol text,
  p_proposed_risk_percent numeric
) returns table(allowed boolean, reason text)
language plpgsql
stable
set search_path to 'public', 'pg_temp'
as $$
declare
  settings public.portfolio_risk_settings%rowtype;
  strategy_row public.strategies%rowtype;
  open_risk numeric;
  symbol_risk numeric;
  strategy_count integer;
  symbol_count integer;
  daily_pl numeric;
  account_balance numeric;
  day_start timestamptz;
begin
  select * into strategy_row
  from public.strategies
  where id = p_strategy_id and terminal_id = p_terminal_id;
  if not found then return query select false, 'strategy not found'; return; end if;

  -- A strategy can relax the account portfolio policy, but never its own
  -- explicitly configured concurrent-position ceiling.
  select count(*) filter (where strategy_id = p_strategy_id)
    into strategy_count
  from public.positions
  where terminal_id = p_terminal_id and status = 'open';
  if strategy_count >= strategy_row.max_concurrent_positions then
    return query select false, 'maximum concurrent positions for strategy reached'; return;
  end if;

  select * into settings
  from public.portfolio_risk_settings
  where terminal_id = p_terminal_id;
  if not found or not settings.enabled then
    return query select true, 'portfolio gate disabled'; return;
  end if;
  if settings.daily_override_until > now() then
    return query select true, 'daily account risk override active'; return;
  end if;
  if strategy_row.override_account_risk then
    return query select true, 'strategy account risk override active'; return;
  end if;

  select context.starts_at into day_start
  from public.terminal_local_day_context(p_terminal_id, now()) context;

  select coalesce(sum(risk_percent),0)
    into open_risk
  from public.positions
  where terminal_id = p_terminal_id and status = 'open';
  select coalesce(sum(risk_percent),0), count(*)
    into symbol_risk, symbol_count
  from public.positions
  where terminal_id = p_terminal_id and status = 'open'
    and coalesce(entry_context->>'canonical_symbol', symbol) = p_symbol;
  select coalesce(sum(net_profit),0) into daily_pl
  from public.trade_history
  where terminal_id = p_terminal_id and close_time >= day_start and profit_verified = true;
  select balance into account_balance from public.mt5_terminals where id = p_terminal_id;

  if open_risk + p_proposed_risk_percent > settings.max_total_open_risk_percent then
    return query select false, 'maximum total open risk reached'; return;
  elsif symbol_risk + p_proposed_risk_percent > settings.max_symbol_open_risk_percent then
    return query select false, 'maximum symbol risk reached'; return;
  elsif symbol_count >= settings.max_positions_per_symbol then
    return query select false, 'maximum positions for symbol reached'; return;
  elsif account_balance > 0 and daily_pl < 0
      and abs(daily_pl) / account_balance * 100 >= settings.max_daily_realized_loss_percent then
    return query select false, 'daily realized loss limit reached'; return;
  end if;
  return query select true, 'ok';
end;
$$;

revoke all on function public.portfolio_risk_gate(uuid,uuid,text,numeric) from public, anon, authenticated;
grant execute on function public.portfolio_risk_gate(uuid,uuid,text,numeric) to service_role;
