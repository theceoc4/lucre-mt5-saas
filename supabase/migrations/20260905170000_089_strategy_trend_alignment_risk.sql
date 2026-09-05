-- Auditable strategy risk adjustment from the terminal-specific M30 trend
-- model. The strategy toggle remains in strategies.config so existing rows
-- preserve their behavior until a user explicitly enables the filter.

alter table public.signals
  add column trend_score numeric(6,2) check (trend_score between -100 and 100),
  add column trend_alignment text not null default 'disabled'
    check (trend_alignment in ('disabled', 'unavailable', 'neutral', 'aligned', 'opposed')),
  add column trend_risk_multiplier numeric(5,3) not null default 1
    check (trend_risk_multiplier > 0 and trend_risk_multiplier <= 3),
  add column trend_model_version text;

comment on column public.signals.trend_score is
  'Terminal-specific symbol_trend_state score captured when this signal was evaluated.';
comment on column public.signals.trend_alignment is
  'Whether the signal agreed with, opposed, or could not use the configured trend filter.';
comment on column public.signals.trend_risk_multiplier is
  'Risk-budget multiplier applied by trend-alignment-v1 before adaptive and news policy factors.';
comment on column public.signals.trend_model_version is
  'Version of the trend-strength model used for the captured adjustment.';

