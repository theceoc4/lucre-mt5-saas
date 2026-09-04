-- v1.0.58 -- remove residual anonymous grants and lock new objects down by default.
--
-- RLS already prevented anonymous callers from seeing tenant rows, but these
-- table privileges were broader than the application needs. Keep both layers:
-- explicit object grants define what a role may attempt, then RLS limits the
-- operation to rows owned by the signed-in user.

revoke all on table public.basket_events from public, anon, authenticated;
revoke all on table public.basket_state from public, anon, authenticated;
revoke all on table public.daily_performance from public, anon, authenticated;
revoke all on table public.hedge_links from public, anon, authenticated;
revoke all on table public.mt5_account_history from public, anon, authenticated;
revoke all on table public.portfolio_risk_settings from public, anon, authenticated;
revoke all on table public.strategy_backtest_runs from public, anon, authenticated;
revoke all on table public.strategy_evaluation_state from public, anon, authenticated;
revoke all on table public.strategy_shadow_signals from public, anon, authenticated;
revoke all on table public.symbol_correlations from public, anon, authenticated;
revoke all on table public.symbol_mappings from public, anon, authenticated;
revoke all on table public.symbol_settings from public, anon, authenticated;
revoke all on table public.symbol_trend_history from public, anon, authenticated;
revoke all on table public.symbol_trend_state from public, anon, authenticated;

-- Owner-scoped read models used by the dashboard.
grant select on table public.basket_events to authenticated;
grant select on table public.basket_state to authenticated;
grant select on table public.daily_performance to authenticated;
grant select on table public.hedge_links to authenticated;
grant select on table public.mt5_account_history to authenticated;
grant select on table public.strategy_backtest_runs to authenticated;
grant select on table public.strategy_evaluation_state to authenticated;
grant select on table public.strategy_shadow_signals to authenticated;
grant select on table public.symbol_correlations to authenticated;
grant select on table public.symbol_trend_history to authenticated;
grant select on table public.symbol_trend_state to authenticated;

-- Owner-controlled settings and the intentionally narrow symbol-map editor.
grant select, insert, update, delete on table public.portfolio_risk_settings to authenticated;
grant select, insert, update, delete on table public.symbol_settings to authenticated;
grant select, update on table public.symbol_mappings to authenticated;

-- The service role remains the only privileged writer for derived/internal data.
grant all on table public.basket_events to service_role;
grant all on table public.basket_state to service_role;
grant all on table public.daily_performance to service_role;
grant all on table public.hedge_links to service_role;
grant all on table public.mt5_account_history to service_role;
grant all on table public.portfolio_risk_settings to service_role;
grant all on table public.strategy_backtest_runs to service_role;
grant all on table public.strategy_evaluation_state to service_role;
grant all on table public.strategy_shadow_signals to service_role;
grant all on table public.symbol_correlations to service_role;
grant all on table public.symbol_mappings to service_role;
grant all on table public.symbol_settings to service_role;
grant all on table public.symbol_trend_history to service_role;
grant all on table public.symbol_trend_state to service_role;

-- These are trigger entry points, not public RPCs. PostgreSQL trigger
-- execution does not require callers to have EXECUTE on the trigger function.
revoke all on function public.on_position_push_event() from public, anon, authenticated;
revoke all on function public.on_trend_extreme_push_event() from public, anon, authenticated;
grant execute on function public.on_position_push_event() to service_role;
grant execute on function public.on_trend_extreme_push_event() to service_role;

-- A legacy symbol-map policy was declared TO public. Its auth.uid() predicate
-- made anonymous access return no rows, but naming the intended role removes
-- ambiguity and prevents accidental widening if the predicate changes later.
alter policy "select own terminal symbol mappings"
  on public.symbol_mappings to authenticated;
alter policy "update own terminal symbol mappings"
  on public.symbol_mappings to authenticated;

-- New tables should not inherit Data API access for anonymous callers. Future
-- migrations must opt browser roles in explicitly, alongside an RLS policy.
alter default privileges in schema public revoke all on tables from anon;

