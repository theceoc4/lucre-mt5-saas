-- v1.0.22 — closed-candle cache for all dashboard-selectable timeframes.

alter table public.price_bars
  drop constraint if exists price_bars_timeframe_check;

alter table public.price_bars
  add constraint price_bars_timeframe_check
  check (timeframe in ('M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1')),
  add column if not exists source_digits smallint,
  add column if not exists spread integer,
  add column if not exists real_volume numeric;

alter table public.price_bars
  add constraint price_bars_source_digits_valid
    check (source_digits is null or source_digits between 0 and 12),
  add constraint price_bars_spread_nonnegative
    check (spread is null or spread >= 0),
  add constraint price_bars_real_volume_nonnegative
    check (real_volume is null or real_volume >= 0);

-- The unique constraint's btree already supports equality on the leading
-- columns and a backward scan by bar_time, so the former duplicate DESC index
-- needlessly doubled index writes and storage.
drop index if exists public.idx_price_bars_terminal_symbol_timeframe_time;

-- Keep enough warm-up for the existing indicator catalog while bounding the
-- operational cache. This deliberately replaces the old seven-day rule,
-- whose retained row count differed wildly by timeframe.
create or replace function public.prune_old_price_bars() returns void
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
begin
  delete from public.price_bars bars
  using (
    select id
    from (
      select
        id,
        row_number() over (
          partition by terminal_id, symbol, timeframe
          order by bar_time desc
        ) as retained_rank
      from public.price_bars
    ) ranked
    where retained_rank > 300
  ) expired
  where bars.id = expired.id;
end;
$$;

comment on function public.prune_old_price_bars is
  'Retains the newest 300 closed candles per terminal/symbol/timeframe for indicator warm-up.';

comment on column public.symbol_settings.timeframes is
  'Selected closed-candle timeframes consumed by the EA price feed and server-side strategy engine.';
