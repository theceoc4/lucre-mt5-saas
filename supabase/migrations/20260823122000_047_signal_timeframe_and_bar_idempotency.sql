-- v1.0.22 — make signal provenance and idempotency timeframe-aware.

alter table public.signals
  add column if not exists timeframe text not null default 'M5',
  add column if not exists source_bar_time timestamptz;

alter table public.signals
  add constraint signals_timeframe_check
  check (timeframe in ('M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1'));

create unique index if not exists uq_signals_strategy_bar_side
  on public.signals(strategy_id, symbol, timeframe, source_bar_time, side)
  where source_bar_time is not null;

create index if not exists idx_signals_terminal_symbol_timeframe_generated
  on public.signals(terminal_id, symbol, timeframe, generated_at desc);

comment on column public.signals.source_bar_time is
  'Open time of the closed candle that produced this signal; used for deterministic deduplication.';
