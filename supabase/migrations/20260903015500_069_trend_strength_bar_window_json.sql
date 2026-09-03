-- Return one JSON value so PostgREST's table row cap cannot truncate a
-- multi-symbol trend window at 1,000 rows.
drop function if exists public.get_trend_strength_bars(uuid, text[]);

create function public.get_trend_strength_bars(
  p_terminal_id uuid,
  p_symbols text[]
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'symbol', ranked.symbol,
        'timeframe', ranked.timeframe,
        'bar_time', ranked.bar_time,
        'open', ranked.open,
        'high', ranked.high,
        'low', ranked.low,
        'close', ranked.close,
        'volume', ranked.volume,
        'real_volume', ranked.real_volume
      ) order by ranked.symbol, ranked.timeframe, ranked.bar_time
    ),
    '[]'::jsonb
  )
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
     or (ranked.timeframe = 'H1' and ranked.row_number <= 160);
$$;

revoke all on function public.get_trend_strength_bars(uuid, text[]) from public, anon, authenticated;
grant execute on function public.get_trend_strength_bars(uuid, text[]) to service_role;

comment on function public.get_trend_strength_bars(uuid, text[]) is
  'Returns all bounded M30 anchor and H1 context windows as one JSON array, avoiding PostgREST row truncation.';
