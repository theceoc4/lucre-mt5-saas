-- v1.0.28 — retire the original preset catalog and make timeframe an
-- explicit strategy property instead of inheriting the removed pair setting.

alter table public.strategies
  add column timeframe text not null default 'M5'
  check (timeframe in ('M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1'));

comment on column public.strategies.timeframe is
  'Closed-candle timeframe evaluated by this strategy configuration.';

-- Preserve attribution and historical signals/trades, but prevent retired
-- implementations from producing any new signals.
update public.strategies
set enabled = false
where kind not in ('momentum_breakout', 'confirmed_trend_pullback');

