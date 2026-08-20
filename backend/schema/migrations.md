# Migration History (metadata only)

Supabase's migration tracking (`supabase_migrations.schema_migrations`) only
retains the version timestamp and name of each applied migration — the
original `.sql` body is **not** stored or recoverable through the management
API once applied. This list is provided for historical/audit context only.
The actual current schema is captured in `tables.md`, `rls_policies.md`, and
`functions_and_triggers.sql` in this same folder (live introspection, not replay).

**Going forward:** save every new migration's SQL into `migrations/<version>_<name>.sql`
in this repo at the same time it's applied via `apply_migration`, so this gap
does not recur.

| Version | Name |
|---|---|
| 20260816222703 | v1_0_0_extensions_and_helpers |
| 20260816222711 | v1_0_0_profiles |
| 20260816222721 | v1_0_0_mt5_terminals |
| 20260816222728 | v1_0_0_strategies |
| 20260816222735 | v1_0_0_positions |
| 20260816222745 | v1_0_0_calendar_events |
| 20260816222755 | v1_0_0_trade_history |
| 20260816222806 | v1_0_0_signals_and_deliveries |
| 20260816223006 | v1_0_0_ea_commands |
| 20260816223017 | v1_0_0_scenario_stats_and_policies |
| 20260816223040 | v1_0_0_row_level_security |
| 20260816223059 | v1_0_0_security_advisor_fixes |
| 20260816223149 | v1_0_0_performance_advisor_fixes |
| 20260817010611 | 013_risk_caps_and_provisioning |
| 20260817011022 | 014_command_context_tagging |
| 20260817024339 | 015_symbol_settings |
| 20260817024348 | 016_pip_distance_orders |
| 20260817024530 | 017_realtime_publication |
| 20260817153230 | 018_terminal_margin_and_regulatory |
| 20260817153249 | 019_terminal_basket_and_risk_config |
| 20260817153300 | 020_strategy_signal_family_and_direction |
| 20260817153325 | 021_basket_and_hedge_tables |
| 20260817153341 | 022_basket_position_and_command_integration |
| 20260817153418 | 023_basket_advisor_fixes |
| 20260817154351 | 024_scenario_stats_profitability_metrics |
| 20260817155808 | 025_adaptive_throttle_engine |
| 20260817160052 | 025b_fix_format_specifiers |
| 20260817162608 | 026_news_policy_and_auto_trading_toggle |
| 20260817170620 | 027_directional_news_policy |
| 20260817184131 | 028_calendar_ingestion_worker |
| 20260817214500 | command_strategy_attribution_and_stuck_sweep |
| 20260818063103 | 030_ea_commands_realtime |
| 20260818063132 | 031_symbol_mappings_and_rescan |
| 20260819123338 | 032_throttle_gate_order_wiring |
| 20260819152844 | throttle_cadence_and_closed_deals_index |
| 20260819154036 | symbol_mappings_pending_manual |
| 20260819161515 | 034_price_bars |
| 20260819161550 | 035_strategy_signal_engine_cron |
| 20260819192045 | 036_realtime_terminals_and_positions_tuning |
| 20260820050746 | 037_realtime_trade_history |
| 20260820064901 | add_closing_reconciliation_and_profit_verified |