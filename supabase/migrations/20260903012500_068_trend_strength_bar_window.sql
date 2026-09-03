-- Fetch bounded per-symbol M30/H1 windows in one database round-trip. This
-- keeps the M30 model inexpensive when many enabled symbols close together.
create or replace function public.get_trend_strength_bars(
  p_terminal_id uuid,
  p_symbols text[]
)
returns table (
  symbol text,
  timeframe text,
  bar_time timestamptz,
  open numeric,
  high numeric,
  low numeric,
  close numeric,
  volume numeric,
  real_volume numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  select ranked.symbol, ranked.timeframe, ranked.bar_time, ranked.open,
         ranked.high, ranked.low, ranked.close, ranked.volume, ranked.real_volume
  from (
    select bars.*,
           row_number() over (
             partition by bars.symbol, bars.timeframe
             order by bars.bar_time desc
           ) as row_number
    from public.price_bars bars
    where bars.terminal_id = p_terminal_id
      and bars.symbol = any(p_symbols)
      and bars.timeframe in ('M30', 'H1')
  ) ranked
  where (ranked.timeframe = 'M30' and ranked.row_number <= 240)
     or (ranked.timeframe = 'H1' and ranked.row_number <= 160)
  order by ranked.symbol, ranked.timeframe, ranked.bar_time;
$$;

revoke all on function public.get_trend_strength_bars(uuid, text[]) from public, anon, authenticated;
grant execute on function public.get_trend_strength_bars(uuid, text[]) to service_role;

comment on function public.get_trend_strength_bars(uuid, text[]) is
  'Returns bounded closed M30 anchor and H1 context windows for Trend Strength v3 in one query.';
