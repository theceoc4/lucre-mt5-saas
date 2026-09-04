-- v1.0.58 -- preserve the bounded daily-risk-override write boundary after 082.
-- Ordinary risk limits remain owner-editable; override timestamps are minted
-- only by set_daily_risk_override(), which clamps the expiry to local midnight.

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

