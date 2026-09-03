-- Promote the closed-candle M30 day-trading trend model.
alter table public.symbol_trend_state
  alter column model_version set default 'trend-strength-v3';

comment on column public.symbol_trend_state.score is
  'Signed -100..100 M30 day-trading trend score. v3 combines EMA/DMI direction, ADX/efficiency regime quality, broker volume participation, and a bounded H1 context modifier.';

comment on column public.symbol_trend_state.timeframe_scores is
  'Model evidence by role. v3 stores the M30 anchor result and optional H1 context instead of averaging all chart timeframes.';

comment on column public.symbol_trend_state.components is
  'Auditable model components including regime quality, efficiency ratio, volume ratio/source, H1 alignment, volatility shock inputs, and extension flag.';

comment on table public.symbol_trend_history is
  'Closed-anchor history for the active trend model, keyed by terminal, symbol, and M30 source candle time.';
