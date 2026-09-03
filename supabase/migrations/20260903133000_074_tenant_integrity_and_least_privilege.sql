-- v1.0.46 -- defense in depth for tenant relationships and API grants.

-- A strategy UUID alone is globally unique, but pairing it with terminal_id at
-- the database boundary prevents a buggy privileged writer from attributing a
-- child row to a strategy owned by another terminal.
alter table public.strategies
  add constraint strategies_id_terminal_id_key unique (id, terminal_id);
alter table public.signals
  add constraint signals_id_terminal_id_key unique (id, terminal_id);

alter table public.agent_policies add constraint agent_policies_strategy_terminal_fkey
  foreign key (strategy_id, terminal_id) references public.strategies(id, terminal_id) not valid;
alter table public.ea_commands add constraint ea_commands_strategy_terminal_fkey
  foreign key (strategy_id, terminal_id) references public.strategies(id, terminal_id) not valid;
alter table public.positions add constraint positions_strategy_terminal_fkey
  foreign key (strategy_id, terminal_id) references public.strategies(id, terminal_id) not valid;
alter table public.scenario_stats add constraint scenario_stats_strategy_terminal_fkey
  foreign key (strategy_id, terminal_id) references public.strategies(id, terminal_id) not valid;
alter table public.signals add constraint signals_strategy_terminal_fkey
  foreign key (strategy_id, terminal_id) references public.strategies(id, terminal_id) not valid;
alter table public.strategy_backtest_runs add constraint strategy_backtest_runs_strategy_terminal_fkey
  foreign key (strategy_id, terminal_id) references public.strategies(id, terminal_id) not valid;
alter table public.strategy_evaluation_state add constraint strategy_evaluation_state_strategy_terminal_fkey
  foreign key (strategy_id, terminal_id) references public.strategies(id, terminal_id) not valid;
alter table public.strategy_shadow_signals add constraint strategy_shadow_signals_strategy_terminal_fkey
  foreign key (strategy_id, terminal_id) references public.strategies(id, terminal_id) not valid;
alter table public.trade_history add constraint trade_history_strategy_terminal_fkey
  foreign key (strategy_id, terminal_id) references public.strategies(id, terminal_id) not valid;
alter table public.signal_deliveries add constraint signal_deliveries_signal_terminal_fkey
  foreign key (signal_id, terminal_id) references public.signals(id, terminal_id) not valid;

alter table public.agent_policies validate constraint agent_policies_strategy_terminal_fkey;
alter table public.ea_commands validate constraint ea_commands_strategy_terminal_fkey;
alter table public.positions validate constraint positions_strategy_terminal_fkey;
alter table public.scenario_stats validate constraint scenario_stats_strategy_terminal_fkey;
alter table public.signals validate constraint signals_strategy_terminal_fkey;
alter table public.strategy_backtest_runs validate constraint strategy_backtest_runs_strategy_terminal_fkey;
alter table public.strategy_evaluation_state validate constraint strategy_evaluation_state_strategy_terminal_fkey;
alter table public.strategy_shadow_signals validate constraint strategy_shadow_signals_strategy_terminal_fkey;
alter table public.trade_history validate constraint trade_history_strategy_terminal_fkey;
alter table public.signal_deliveries validate constraint signal_deliveries_signal_terminal_fkey;

-- RLS controls row reads/writes, but structural privileges such as TRUNCATE do
-- not pass through row policies. Browser roles do not need those privileges.
do $$
declare
  relation record;
begin
  for relation in
    select namespace.nspname as schema_name, class.relname as relation_name
    from pg_class class
    join pg_namespace namespace on namespace.oid = class.relnamespace
    where namespace.nspname = 'public'
      and class.relkind in ('r', 'p')
  loop
    execute format(
      'revoke truncate, references, trigger on table %I.%I from public, anon, authenticated',
      relation.schema_name,
      relation.relation_name
    );
  end loop;
end
$$;

-- PostgreSQL grants EXECUTE on new functions to PUBLIC by default. Make the
-- API allow-list explicit: two ownership-checking strategy RPCs plus the pure
-- definition validator are browser-callable; internal/worker functions are not.
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
grant execute on function public.set_strategy_enabled(uuid, boolean) to authenticated;
grant execute on function public.promote_strategy_to_live(uuid) to authenticated;
grant execute on function public.valid_strategy_definition(jsonb) to authenticated;

alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public grant execute on functions to service_role;
