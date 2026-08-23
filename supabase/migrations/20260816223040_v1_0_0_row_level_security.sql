-- Revoke the default anon access Supabase grants on new tables.
revoke all on public.profiles, public.mt5_terminals, public.strategies, public.positions,
  public.trade_history, public.calendar_events, public.signals, public.signal_deliveries,
  public.ea_commands, public.scenario_stats, public.agent_policies
  from anon;

-- ---------------- profiles ----------------
alter table public.profiles enable row level security;

create policy "profiles_select_own" on public.profiles
  for select to authenticated using (id = auth.uid());

create policy "profiles_update_own" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- ---------------- mt5_terminals ----------------
alter table public.mt5_terminals enable row level security;

create policy "mt5_terminals_select_own" on public.mt5_terminals
  for select to authenticated using (user_id = auth.uid());

create policy "mt5_terminals_insert_own" on public.mt5_terminals
  for insert to authenticated with check (user_id = auth.uid());

create policy "mt5_terminals_update_own" on public.mt5_terminals
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "mt5_terminals_delete_own" on public.mt5_terminals
  for delete to authenticated using (user_id = auth.uid());

revoke update on public.mt5_terminals from authenticated;
grant update (label, broker, account_login, server, is_live) on public.mt5_terminals to authenticated;

-- ---------------- strategies ----------------
alter table public.strategies enable row level security;

create policy "strategies_all_own_terminal" on public.strategies
  for all to authenticated
  using (exists (
    select 1 from public.mt5_terminals t
    where t.id = strategies.terminal_id and t.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.mt5_terminals t
    where t.id = strategies.terminal_id and t.user_id = auth.uid()
  ));

-- ---------------- positions (read-only to dashboard; EA/edge functions write) ----------------
alter table public.positions enable row level security;

create policy "positions_select_own_terminal" on public.positions
  for select to authenticated
  using (exists (
    select 1 from public.mt5_terminals t
    where t.id = positions.terminal_id and t.user_id = auth.uid()
  ));

revoke insert, update, delete on public.positions from authenticated;

-- ---------------- trade_history (read-only) ----------------
alter table public.trade_history enable row level security;

create policy "trade_history_select_own_terminal" on public.trade_history
  for select to authenticated
  using (exists (
    select 1 from public.mt5_terminals t
    where t.id = trade_history.terminal_id and t.user_id = auth.uid()
  ));

revoke insert, update, delete on public.trade_history from authenticated;

-- ---------------- calendar_events (global read-only reference data) ----------------
alter table public.calendar_events enable row level security;

create policy "calendar_events_select_all" on public.calendar_events
  for select to authenticated using (true);

revoke insert, update, delete on public.calendar_events from authenticated;

-- ---------------- signals (read-only) ----------------
alter table public.signals enable row level security;

create policy "signals_select_own_terminal" on public.signals
  for select to authenticated
  using (exists (
    select 1 from public.mt5_terminals t
    where t.id = signals.terminal_id and t.user_id = auth.uid()
  ));

revoke insert, update, delete on public.signals from authenticated;

-- ---------------- signal_deliveries (read-only; taps go through an edge function) ----------------
alter table public.signal_deliveries enable row level security;

create policy "signal_deliveries_select_own_terminal" on public.signal_deliveries
  for select to authenticated
  using (exists (
    select 1 from public.mt5_terminals t
    where t.id = signal_deliveries.terminal_id and t.user_id = auth.uid()
  ));

revoke insert, update, delete on public.signal_deliveries from authenticated;

-- ---------------- ea_commands (read-only; the dashboard never writes here directly) ----------------
alter table public.ea_commands enable row level security;

create policy "ea_commands_select_own_terminal" on public.ea_commands
  for select to authenticated
  using (exists (
    select 1 from public.mt5_terminals t
    where t.id = ea_commands.terminal_id and t.user_id = auth.uid()
  ));

revoke insert, update, delete on public.ea_commands from authenticated;

-- ---------------- scenario_stats (read-only analytics) ----------------
alter table public.scenario_stats enable row level security;

create policy "scenario_stats_select_own_terminal" on public.scenario_stats
  for select to authenticated
  using (exists (
    select 1 from public.mt5_terminals t
    where t.id = scenario_stats.terminal_id and t.user_id = auth.uid()
  ));

revoke insert, update, delete on public.scenario_stats from authenticated;

-- ---------------- agent_policies (read-only, explains why signals were blocked) ----------------
alter table public.agent_policies enable row level security;

create policy "agent_policies_select_own_terminal" on public.agent_policies
  for select to authenticated
  using (exists (
    select 1 from public.mt5_terminals t
    where t.id = agent_policies.terminal_id and t.user_id = auth.uid()
  ));

revoke insert, update, delete on public.agent_policies from authenticated;
;
