-- ---------------- profiles ----------------
drop policy "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select to authenticated using (id = (select auth.uid()));

drop policy "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- ---------------- mt5_terminals ----------------
drop policy "mt5_terminals_select_own" on public.mt5_terminals;
create policy "mt5_terminals_select_own" on public.mt5_terminals
  for select to authenticated using (user_id = (select auth.uid()));

drop policy "mt5_terminals_insert_own" on public.mt5_terminals;
create policy "mt5_terminals_insert_own" on public.mt5_terminals
  for insert to authenticated with check (user_id = (select auth.uid()));

drop policy "mt5_terminals_update_own" on public.mt5_terminals;
create policy "mt5_terminals_update_own" on public.mt5_terminals
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy "mt5_terminals_delete_own" on public.mt5_terminals;
create policy "mt5_terminals_delete_own" on public.mt5_terminals
  for delete to authenticated using (user_id = (select auth.uid()));

-- ---------------- strategies ----------------
drop policy "strategies_all_own_terminal" on public.strategies;
create policy "strategies_all_own_terminal" on public.strategies
  for all to authenticated
  using (exists (
    select 1 from public.mt5_terminals t
    where t.id = strategies.terminal_id and t.user_id = (select auth.uid())
  ))
  with check (exists (
    select 1 from public.mt5_terminals t
    where t.id = strategies.terminal_id and t.user_id = (select auth.uid())
  ));

-- ---------------- positions ----------------
drop policy "positions_select_own_terminal" on public.positions;
create policy "positions_select_own_terminal" on public.positions
  for select to authenticated
  using (exists (
    select 1 from public.mt5_terminals t
    where t.id = positions.terminal_id and t.user_id = (select auth.uid())
  ));

-- ---------------- trade_history ----------------
drop policy "trade_history_select_own_terminal" on public.trade_history;
create policy "trade_history_select_own_terminal" on public.trade_history
  for select to authenticated
  using (exists (
    select 1 from public.mt5_terminals t
    where t.id = trade_history.terminal_id and t.user_id = (select auth.uid())
  ));

-- ---------------- signals ----------------
drop policy "signals_select_own_terminal" on public.signals;
create policy "signals_select_own_terminal" on public.signals
  for select to authenticated
  using (exists (
    select 1 from public.mt5_terminals t
    where t.id = signals.terminal_id and t.user_id = (select auth.uid())
  ));

-- ---------------- signal_deliveries ----------------
drop policy "signal_deliveries_select_own_terminal" on public.signal_deliveries;
create policy "signal_deliveries_select_own_terminal" on public.signal_deliveries
  for select to authenticated
  using (exists (
    select 1 from public.mt5_terminals t
    where t.id = signal_deliveries.terminal_id and t.user_id = (select auth.uid())
  ));

-- ---------------- ea_commands ----------------
drop policy "ea_commands_select_own_terminal" on public.ea_commands;
create policy "ea_commands_select_own_terminal" on public.ea_commands
  for select to authenticated
  using (exists (
    select 1 from public.mt5_terminals t
    where t.id = ea_commands.terminal_id and t.user_id = (select auth.uid())
  ));

-- ---------------- scenario_stats ----------------
drop policy "scenario_stats_select_own_terminal" on public.scenario_stats;
create policy "scenario_stats_select_own_terminal" on public.scenario_stats
  for select to authenticated
  using (exists (
    select 1 from public.mt5_terminals t
    where t.id = scenario_stats.terminal_id and t.user_id = (select auth.uid())
  ));

-- ---------------- agent_policies ----------------
drop policy "agent_policies_select_own_terminal" on public.agent_policies;
create policy "agent_policies_select_own_terminal" on public.agent_policies
  for select to authenticated
  using (exists (
    select 1 from public.mt5_terminals t
    where t.id = agent_policies.terminal_id and t.user_id = (select auth.uid())
  ));

-- ---------------- missing FK covering indexes ----------------
create index idx_agent_policies_scenario_stats_id on public.agent_policies(scenario_stats_id);
create index idx_agent_policies_strategy_id on public.agent_policies(strategy_id);
create index idx_ea_commands_signal_delivery_id on public.ea_commands(signal_delivery_id);
create index idx_positions_strategy_id on public.positions(strategy_id);
create index idx_scenario_stats_strategy_id on public.scenario_stats(strategy_id);
create index idx_signal_deliveries_ea_command_id on public.signal_deliveries(ea_command_id);
create index idx_signals_news_event_id on public.signals(news_event_id);
create index idx_signals_strategy_id on public.signals(strategy_id);
create index idx_trade_history_news_event_id on public.trade_history(news_event_id);
create index idx_trade_history_strategy_id on public.trade_history(strategy_id);
;
