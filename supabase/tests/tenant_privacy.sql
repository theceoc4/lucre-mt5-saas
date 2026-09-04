-- Read-only deployment smoke test for the privacy-critical boundaries.
-- Run with: supabase db query --linked --file supabase/tests/tenant_privacy.sql

do $$
declare
  reservation_rls boolean;
begin
  if exists (
    select 1
    from pg_class class
    join pg_namespace namespace on namespace.oid = class.relnamespace
    where namespace.nspname = 'public'
      and class.relkind in ('r', 'p')
      and not class.relrowsecurity
  ) then
    raise exception 'privacy audit failed: a public table does not have RLS enabled';
  end if;
  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and (coalesce(qual, '') = 'true' or coalesce(with_check, '') = 'true')
  ) then
    raise exception 'privacy audit failed: tenant data has an unrestricted RLS policy';
  end if;
  if exists (
    select 1
    from (values
      ('calendar_events'),
      ('market_feed_health'),
      ('symbol_correlations')
    ) required(table_name)
    where not exists (
      select 1 from information_schema.columns column_info
      where column_info.table_schema = 'public'
        and column_info.table_name = required.table_name
        and column_info.column_name = 'terminal_id'
        and column_info.is_nullable = 'NO'
    )
  ) then
    raise exception 'privacy audit failed: MT5 market data is not terminal-scoped';
  end if;
  if exists (
    select 1
    from information_schema.role_table_grants
    where table_schema = 'public'
      and grantee = 'anon'
  ) then
    raise exception 'privacy audit failed: anonymous role retains public table grants';
  end if;
  select relrowsecurity into reservation_rls
  from pg_class
  where oid = 'public.open_command_reservations'::regclass;

  if reservation_rls is not true then
    raise exception 'privacy audit failed: open_command_reservations RLS is disabled';
  end if;
  if has_table_privilege('anon', 'public.open_command_reservations', 'select')
     or has_table_privilege('authenticated', 'public.open_command_reservations', 'select')
     or has_table_privilege('anon', 'public.open_command_reservations', 'insert')
     or has_table_privilege('authenticated', 'public.open_command_reservations', 'insert') then
    raise exception 'privacy audit failed: reservation table is browser-accessible';
  end if;
  if exists (
    select 1
    from pg_class class
    join pg_namespace namespace on namespace.oid = class.relnamespace
    where namespace.nspname = 'public'
      and class.relkind in ('r', 'p')
      and (
        has_table_privilege('anon', class.oid, 'truncate')
        or has_table_privilege('authenticated', class.oid, 'truncate')
        or has_table_privilege('anon', class.oid, 'trigger')
        or has_table_privilege('authenticated', class.oid, 'trigger')
      )
  ) then
    raise exception 'privacy audit failed: browser role has structural table privileges';
  end if;
  if has_function_privilege('anon', 'public.broadcast_ea_command_available()', 'execute')
     or has_function_privilege('authenticated', 'public.broadcast_ea_command_available()', 'execute') then
    raise exception 'privacy audit failed: command broadcast trigger is browser-callable';
  end if;
  if has_function_privilege('anon', 'public.on_position_push_event()', 'execute')
     or has_function_privilege('authenticated', 'public.on_position_push_event()', 'execute')
     or has_function_privilege('anon', 'public.on_trend_extreme_push_event()', 'execute')
     or has_function_privilege('authenticated', 'public.on_trend_extreme_push_event()', 'execute') then
    raise exception 'privacy audit failed: push trigger helper is browser-callable';
  end if;
  if has_function_privilege('anon', 'public.promote_strategy_to_live(uuid)', 'execute') then
    raise exception 'privacy audit failed: anonymous strategy promotion is enabled';
  end if;
  if has_function_privilege('anon', 'public.set_daily_risk_override(uuid,boolean)', 'execute')
     or not has_function_privilege('authenticated', 'public.set_daily_risk_override(uuid,boolean)', 'execute') then
    raise exception 'privacy audit failed: daily risk override role grants are incorrect';
  end if;
  if has_column_privilege('authenticated', 'public.portfolio_risk_settings', 'daily_override_until', 'update')
     or has_column_privilege('authenticated', 'public.portfolio_risk_settings', 'daily_override_started_at', 'insert') then
    raise exception 'privacy audit failed: override timestamps can be written outside the bounded RPC';
  end if;
  if has_function_privilege('anon', 'public.terminal_local_day_context(uuid,timestamp with time zone)', 'execute') then
    raise exception 'privacy audit failed: anonymous local-day lookup is enabled';
  end if;
  if has_function_privilege('anon', 'public.terminal_daily_risk_override_active(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.terminal_daily_risk_override_active(uuid)', 'execute') then
    raise exception 'privacy audit failed: internal override status helper is browser-callable';
  end if;
  if has_function_privilege('anon', 'public.broadcast_private_position_state(uuid,jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.broadcast_private_position_state(uuid,jsonb)', 'execute') then
    raise exception 'privacy audit failed: private position relay is browser-callable';
  end if;
  if has_function_privilege('anon', 'public.broadcast_private_terminal_event(uuid,text,jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.broadcast_private_terminal_event(uuid,text,jsonb)', 'execute') then
    raise exception 'privacy audit failed: private terminal event relay is browser-callable';
  end if;
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename in ('price_feed_series_state', 'symbol_trend_state')
  ) then
    raise exception 'realtime efficiency audit failed: high-churn market state remains row-published';
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'market_feed_health'
      and column_name = 'last_source_terminal_id'
  ) then
    raise exception 'privacy audit failed: shared feed health exposes a terminal id';
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'realtime'
      and tablename = 'messages'
      and policyname = 'terminal_owner_receives_private_position_state'
      and 'authenticated' = any(roles)
  ) then
    raise exception 'privacy audit failed: private position topic policy is missing';
  end if;
end
$$;

select 'tenant privacy checks passed' as result;
