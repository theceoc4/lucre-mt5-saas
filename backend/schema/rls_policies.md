# Row-Level Security Policies

Introspected live via `pg_policy` (see `../schema/tables.md` for the schema-snapshot caveat).

## `agent_policies`
- **agent_policies_select_own_terminal** (SELECT)
  - USING: `(EXISTS ( SELECT 1
   FROM mt5_terminals t
  WHERE ((t.id = agent_policies.terminal_id) AND (t.user_id = ( SELECT auth.uid() AS uid)))))`

## `basket_events`
- **basket_events_select_own_terminal** (SELECT)
  - USING: `(EXISTS ( SELECT 1
   FROM mt5_terminals t
  WHERE ((t.id = basket_events.terminal_id) AND (t.user_id = auth.uid()))))`

## `basket_state`
- **basket_state_select_own_terminal** (SELECT)
  - USING: `(EXISTS ( SELECT 1
   FROM mt5_terminals t
  WHERE ((t.id = basket_state.terminal_id) AND (t.user_id = auth.uid()))))`

## `calendar_events`
- **calendar_events_select_all** (SELECT)
  - USING: `true`

## `daily_performance`
- **daily_performance_select_own_terminal** (SELECT)
  - USING: `(EXISTS ( SELECT 1
   FROM mt5_terminals t
  WHERE ((t.id = daily_performance.terminal_id) AND (t.user_id = auth.uid()))))`

## `ea_commands`
- **ea_commands_select_own_terminal** (SELECT)
  - USING: `(EXISTS ( SELECT 1
   FROM mt5_terminals t
  WHERE ((t.id = ea_commands.terminal_id) AND (t.user_id = ( SELECT auth.uid() AS uid)))))`

## `hedge_links`
- **hedge_links_select_own_terminal** (SELECT)
  - USING: `(EXISTS ( SELECT 1
   FROM (positions p
     JOIN mt5_terminals t ON ((t.id = p.terminal_id)))
  WHERE ((p.id = hedge_links.position_id) AND (t.user_id = auth.uid()))))`

## `mt5_terminals`
- **mt5_terminals_delete_own** (DELETE)
  - USING: `(user_id = ( SELECT auth.uid() AS uid))`
- **mt5_terminals_insert_own** (INSERT)
  - WITH CHECK: `(user_id = ( SELECT auth.uid() AS uid))`
- **mt5_terminals_select_own** (SELECT)
  - USING: `(user_id = ( SELECT auth.uid() AS uid))`
- **mt5_terminals_update_own** (UPDATE)
  - USING: `(user_id = ( SELECT auth.uid() AS uid))`
  - WITH CHECK: `(user_id = ( SELECT auth.uid() AS uid))`

## `positions`
- **positions_select_own_terminal** (SELECT)
  - USING: `(EXISTS ( SELECT 1
   FROM mt5_terminals t
  WHERE ((t.id = positions.terminal_id) AND (t.user_id = ( SELECT auth.uid() AS uid)))))`

## `price_bars`
- **price_bars_select_own_terminal** (SELECT)
  - USING: `(EXISTS ( SELECT 1
   FROM mt5_terminals t
  WHERE ((t.id = price_bars.terminal_id) AND (t.user_id = auth.uid()))))`

## `profiles`
- **profiles_select_own** (SELECT)
  - USING: `(id = ( SELECT auth.uid() AS uid))`
- **profiles_update_own** (UPDATE)
  - USING: `(id = ( SELECT auth.uid() AS uid))`
  - WITH CHECK: `(id = ( SELECT auth.uid() AS uid))`

## `scenario_stats`
- **scenario_stats_select_own_terminal** (SELECT)
  - USING: `(EXISTS ( SELECT 1
   FROM mt5_terminals t
  WHERE ((t.id = scenario_stats.terminal_id) AND (t.user_id = ( SELECT auth.uid() AS uid)))))`

## `signal_deliveries`
- **signal_deliveries_select_own_terminal** (SELECT)
  - USING: `(EXISTS ( SELECT 1
   FROM mt5_terminals t
  WHERE ((t.id = signal_deliveries.terminal_id) AND (t.user_id = ( SELECT auth.uid() AS uid)))))`

## `signals`
- **signals_select_own_terminal** (SELECT)
  - USING: `(EXISTS ( SELECT 1
   FROM mt5_terminals t
  WHERE ((t.id = signals.terminal_id) AND (t.user_id = ( SELECT auth.uid() AS uid)))))`

## `strategies`
- **strategies_all_own_terminal** (ALL)
  - USING: `(EXISTS ( SELECT 1
   FROM mt5_terminals t
  WHERE ((t.id = strategies.terminal_id) AND (t.user_id = ( SELECT auth.uid() AS uid)))))`
  - WITH CHECK: `(EXISTS ( SELECT 1
   FROM mt5_terminals t
  WHERE ((t.id = strategies.terminal_id) AND (t.user_id = ( SELECT auth.uid() AS uid)))))`

## `symbol_correlations`
- **symbol_correlations_select_all** (SELECT)
  - USING: `true`

## `symbol_mappings`
- **select own terminal symbol mappings** (SELECT)
  - USING: `(terminal_id IN ( SELECT mt5_terminals.id
   FROM mt5_terminals
  WHERE (mt5_terminals.user_id = auth.uid())))`
- **update own terminal symbol mappings** (UPDATE)
  - USING: `(terminal_id IN ( SELECT mt5_terminals.id
   FROM mt5_terminals
  WHERE (mt5_terminals.user_id = auth.uid())))`

## `symbol_settings`
- **symbol_settings_all_own_terminal** (ALL)
  - USING: `(EXISTS ( SELECT 1
   FROM mt5_terminals t
  WHERE ((t.id = symbol_settings.terminal_id) AND (t.user_id = auth.uid()))))`
  - WITH CHECK: `(EXISTS ( SELECT 1
   FROM mt5_terminals t
  WHERE ((t.id = symbol_settings.terminal_id) AND (t.user_id = auth.uid()))))`

## `trade_history`
- **trade_history_select_own_terminal** (SELECT)
  - USING: `(EXISTS ( SELECT 1
   FROM mt5_terminals t
  WHERE ((t.id = trade_history.terminal_id) AND (t.user_id = ( SELECT auth.uid() AS uid)))))`
