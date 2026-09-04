-- v1.0.57 -- one local-calendar-day portfolio override and shared day bounds.
--
-- A "day" is owned by the user's saved IANA timezone, not the broker clock or
-- the database server's UTC date. The override stores an absolute expiry so it
-- resets cleanly at the next local midnight, including across DST changes.

alter table public.portfolio_risk_settings
  add column if not exists daily_override_started_at timestamptz,
  add column if not exists daily_override_until timestamptz,
  add column if not exists daily_override_timezone text;

comment on column public.portfolio_risk_settings.daily_override_until is
  'Account risk guardrails are bypassed only while now() is before this instant. Set from the owner local timezone and automatically inactive after local midnight.';

-- Owners may edit ordinary guardrails directly, but override timestamps can
-- only be minted by set_daily_risk_override(), which clamps them to midnight.
revoke insert, update on table public.portfolio_risk_settings from authenticated;
grant insert (
  terminal_id, enabled, max_total_open_risk_percent,
  max_symbol_open_risk_percent, max_positions_per_symbol,
  max_daily_realized_loss_percent
) on table public.portfolio_risk_settings to authenticated;
grant update (
  enabled, max_total_open_risk_percent, max_symbol_open_risk_percent,
  max_positions_per_symbol, max_daily_realized_loss_percent
) on table public.portfolio_risk_settings to authenticated;

create or replace function public.terminal_timezone(p_terminal_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (
      select zones.name
      from public.mt5_terminals terminal
      left join public.profiles profile on profile.id = terminal.user_id
      left join pg_catalog.pg_timezone_names zones on zones.name = profile.timezone
      where terminal.id = p_terminal_id
      limit 1
    ),
    'UTC'
  );
$$;

revoke all on function public.terminal_timezone(uuid) from public, anon, authenticated;
grant execute on function public.terminal_timezone(uuid) to service_role;

create or replace function public.terminal_local_day_context(
  p_terminal_id uuid,
  p_at timestamptz default now()
)
returns table(
  local_date date,
  timezone text,
  starts_at timestamptz,
  ends_at timestamptz,
  override_active boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner uuid;
  v_timezone text;
  v_local_date date;
begin
  select user_id into v_owner from public.mt5_terminals where id = p_terminal_id;
  if not found then raise exception 'terminal_not_found'; end if;
  if coalesce(auth.role(), '') <> 'service_role' and v_owner is distinct from auth.uid() then
    raise exception 'forbidden';
  end if;

  v_timezone := public.terminal_timezone(p_terminal_id);
  v_local_date := (p_at at time zone v_timezone)::date;

  return query
  select
    v_local_date,
    v_timezone,
    (v_local_date::timestamp at time zone v_timezone),
    ((v_local_date + 1)::timestamp at time zone v_timezone),
    exists (
      select 1
      from public.portfolio_risk_settings settings
      where settings.terminal_id = p_terminal_id
        and settings.daily_override_until > p_at
    );
end;
$$;

revoke all on function public.terminal_local_day_context(uuid,timestamptz) from public, anon;
grant execute on function public.terminal_local_day_context(uuid,timestamptz) to authenticated, service_role;

create or replace function public.terminal_daily_risk_override_active(p_terminal_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.portfolio_risk_settings settings
    where settings.terminal_id = p_terminal_id
      and settings.daily_override_until > now()
  );
$$;

revoke all on function public.terminal_daily_risk_override_active(uuid) from public, anon, authenticated;
grant execute on function public.terminal_daily_risk_override_active(uuid) to service_role;

create or replace function public.set_daily_risk_override(
  p_terminal_id uuid,
  p_enabled boolean
)
returns public.portfolio_risk_settings
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner uuid;
  v_timezone text;
  v_local_date date;
  v_result public.portfolio_risk_settings%rowtype;
begin
  select user_id into v_owner from public.mt5_terminals where id = p_terminal_id;
  if not found then raise exception 'terminal_not_found'; end if;
  if v_owner is distinct from auth.uid() then raise exception 'forbidden'; end if;

  v_timezone := public.terminal_timezone(p_terminal_id);
  v_local_date := (now() at time zone v_timezone)::date;

  insert into public.portfolio_risk_settings (terminal_id)
  values (p_terminal_id)
  on conflict (terminal_id) do nothing;

  update public.portfolio_risk_settings
  set daily_override_started_at = case when p_enabled then now() else null end,
      daily_override_until = case
        when p_enabled then ((v_local_date + 1)::timestamp at time zone v_timezone)
        else null
      end,
      daily_override_timezone = case when p_enabled then v_timezone else null end
  where terminal_id = p_terminal_id
  returning * into v_result;

  return v_result;
end;
$$;

revoke all on function public.set_daily_risk_override(uuid,boolean) from public, anon;
grant execute on function public.set_daily_risk_override(uuid,boolean) to authenticated;

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
  select * into settings from public.portfolio_risk_settings where terminal_id = p_terminal_id;
  if not found or not settings.enabled then return query select true, 'portfolio gate disabled'; return; end if;
  if settings.daily_override_until > now() then return query select true, 'daily account risk override active'; return; end if;

  select * into strategy_row from public.strategies where id = p_strategy_id and terminal_id = p_terminal_id;
  if not found then return query select false, 'strategy not found'; return; end if;

  select context.starts_at into day_start
  from public.terminal_local_day_context(p_terminal_id, now()) context;

  select coalesce(sum(risk_percent),0), count(*) filter (where strategy_id = p_strategy_id)
    into open_risk, strategy_count from public.positions where terminal_id = p_terminal_id and status = 'open';
  select coalesce(sum(risk_percent),0), count(*) into symbol_risk, symbol_count
    from public.positions where terminal_id = p_terminal_id and status = 'open'
      and coalesce(entry_context->>'canonical_symbol', symbol) = p_symbol;
  select coalesce(sum(net_profit),0) into daily_pl from public.trade_history
    where terminal_id = p_terminal_id and close_time >= day_start and profit_verified = true;
  select balance into account_balance from public.mt5_terminals where id = p_terminal_id;

  if open_risk + p_proposed_risk_percent > settings.max_total_open_risk_percent then
    return query select false, 'maximum total open risk reached'; return;
  elsif symbol_risk + p_proposed_risk_percent > settings.max_symbol_open_risk_percent then
    return query select false, 'maximum symbol risk reached'; return;
  elsif symbol_count >= settings.max_positions_per_symbol then
    return query select false, 'maximum positions for symbol reached'; return;
  elsif strategy_count >= strategy_row.max_concurrent_positions then
    return query select false, 'maximum concurrent positions for strategy reached'; return;
  elsif account_balance > 0 and daily_pl < 0 and abs(daily_pl) / account_balance * 100 >= settings.max_daily_realized_loss_percent then
    return query select false, 'daily realized loss limit reached'; return;
  end if;
  return query select true, 'ok';
end;
$$;

grant execute on function public.portfolio_risk_gate(uuid,uuid,text,numeric) to service_role;

-- Keep the atomic reservation, but let an explicit owner override bypass the
-- configurable account position ceiling for the remainder of the local day.
-- Broker, margin, volume, market and EA hard-safety checks still apply.
create or replace function public.reserve_open_command_slot()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_max_open_positions int;
  v_open_positions int;
  v_reserved_positions int;
  v_override_active boolean;
begin
  if new.command_type not in ('open', 'hedge_open') then return new; end if;

  select max_open_positions
    into v_max_open_positions
    from public.mt5_terminals
   where id = new.terminal_id
   for update;
  if not found then raise exception using errcode = 'P0001', message = 'terminal_not_found'; end if;

  v_override_active := public.terminal_daily_risk_override_active(new.terminal_id);
  if not v_override_active then
    select count(*) into v_open_positions
      from public.positions
     where terminal_id = new.terminal_id and status = 'open';
    select count(*) into v_reserved_positions
      from public.open_command_reservations
     where terminal_id = new.terminal_id;
    if v_open_positions + v_reserved_positions >= v_max_open_positions then
      raise exception using errcode = 'P0001', message = 'max_open_positions_reached';
    end if;
  end if;

  insert into public.open_command_reservations (ea_command_id, terminal_id)
  values (new.id, new.terminal_id);
  return new;
end;
$$;
