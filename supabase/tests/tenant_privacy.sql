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
      and tablename not in ('calendar_events', 'market_feed_health', 'symbol_correlations')
  ) then
    raise exception 'privacy audit failed: tenant data has an unrestricted RLS policy';
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
  if has_function_privilege('anon', 'public.promote_strategy_to_live(uuid)', 'execute') then
    raise exception 'privacy audit failed: anonymous strategy promotion is enabled';
  end if;
  if has_function_privilege('anon', 'public.broadcast_private_position_state(uuid,jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.broadcast_private_position_state(uuid,jsonb)', 'execute') then
    raise exception 'privacy audit failed: private position relay is browser-callable';
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
