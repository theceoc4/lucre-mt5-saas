-- v1.0.40 -- Deadline-driven live candles are acknowledged only after one
-- transaction has stored, retained, checkpointed, and marked every series.

alter table public.price_feed_series_state
  drop constraint if exists price_feed_series_state_collector_state_check;

alter table public.price_feed_series_state
  add constraint price_feed_series_state_collector_state_check
  check (collector_state in (
    'idle','sync_requested','waiting_history','awaiting_tick','ready',
    'upload_pending','uploading','retry_backoff','market_closed','error'
  ));

alter table public.price_feed_series_state
  add column expected_bar_time timestamptz,
  add column source_tick_time timestamptz,
  add column ingest_lag_seconds integer
    check (ingest_lag_seconds is null or ingest_lag_seconds >= 0);

create or replace function public.ingest_price_bar_batch(
  p_terminal_id uuid,
  p_rows jsonb,
  p_batches jsonb
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  inserted_count integer := 0;
  removed_count integer := 0;
begin
  if jsonb_typeof(p_rows) is distinct from 'array'
     or jsonb_typeof(p_batches) is distinct from 'array' then
    raise exception 'rows and batches must be JSON arrays';
  end if;

  insert into public.price_bars (
    terminal_id, symbol, timeframe, bar_time, open, high, low, close,
    volume, source_digits, spread, real_volume
  )
  select
    p_terminal_id, row.symbol, row.timeframe, row.bar_time,
    row.open, row.high, row.low, row.close, row.volume,
    row.source_digits, row.spread, row.real_volume
  from jsonb_to_recordset(p_rows) as row(
    symbol text, timeframe text, bar_time timestamptz,
    open numeric, high numeric, low numeric, close numeric, volume numeric,
    source_digits integer, spread integer, real_volume numeric
  )
  on conflict (terminal_id, symbol, timeframe, bar_time) do update set
    open = excluded.open,
    high = excluded.high,
    low = excluded.low,
    close = excluded.close,
    volume = excluded.volume,
    source_digits = excluded.source_digits,
    spread = excluded.spread,
    real_volume = excluded.real_volume;
  get diagnostics inserted_count = row_count;

  with requested as (
    select distinct batch.symbol, batch.timeframe
    from jsonb_to_recordset(p_batches) as batch(symbol text, timeframe text)
  ), expired as (
    select id from (
      select bars.id,
        row_number() over (
          partition by bars.symbol, bars.timeframe
          order by bars.bar_time desc
        ) retained_rank
      from public.price_bars bars
      join requested on requested.symbol = bars.symbol
        and requested.timeframe = bars.timeframe
      where bars.terminal_id = p_terminal_id
    ) ranked
    where retained_rank > 1000
  )
  delete from public.price_bars bars using expired where bars.id = expired.id;
  get diagnostics removed_count = row_count;

  -- Reuse the established generation/history-floor rules inside this same
  -- PostgreSQL transaction. Any later failure rolls the candle insert back.
  perform public.record_price_feed_batches(p_terminal_id, p_batches);

  update public.price_feed_series_state state set
    collector_state = 'idle',
    collector_attempt_count = 0,
    collector_last_error = null,
    collector_reported_at = now(),
    collector_next_retry_at = null,
    source_latest_bar_time = batch.latest_bar_time,
    last_upload_status = 200,
    last_success_at = now(),
    expected_bar_time = null,
    ingest_lag_seconds = greatest(
      0,
      extract(epoch from (now() - batch.latest_bar_time))::integer -
      case batch.timeframe
        when 'M1' then 60 when 'M5' then 300 when 'M15' then 900
        when 'M30' then 1800 when 'H1' then 3600 when 'H4' then 14400
        when 'D1' then 86400 when 'W1' then 604800 else 0
      end
    ),
    updated_at = now()
  from jsonb_to_recordset(p_batches) as batch(
    symbol text, timeframe text, latest_bar_time timestamptz
  )
  where state.terminal_id = p_terminal_id
    and state.symbol = batch.symbol
    and state.timeframe = batch.timeframe;

  return jsonb_build_object(
    'accepted', inserted_count,
    'pruned', removed_count
  );
end;
$$;

revoke all on function public.ingest_price_bar_batch(uuid,jsonb,jsonb)
  from public, anon, authenticated;
grant execute on function public.ingest_price_bar_batch(uuid,jsonb,jsonb)
  to service_role;

comment on function public.ingest_price_bar_batch(uuid,jsonb,jsonb) is
  'Atomically upserts broker candles, enforces 1,000-row retention, advances durable checkpoints, and acknowledges collector health.';

create or replace function public.record_price_feed_attempts(
  p_terminal_id uuid,
  p_attempts jsonb
) returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  attempt jsonb;
  affected integer := 0;
  changed integer;
  next_retry_seconds integer;
begin
  if jsonb_typeof(p_attempts) is distinct from 'array' then
    raise exception 'p_attempts must be a JSON array';
  end if;
  for attempt in select value from jsonb_array_elements(p_attempts)
  loop
    if coalesce(attempt->>'state', '') not in (
      'idle','sync_requested','waiting_history','awaiting_tick','ready',
      'upload_pending','uploading','retry_backoff','market_closed','error'
    ) then continue; end if;
    next_retry_seconds := greatest(coalesce((attempt->>'retry_after_seconds')::integer, 0), 0);
    update public.price_feed_series_state set
      collector_state = attempt->>'state',
      collector_attempt_count = greatest(
        collector_attempt_count,
        greatest(coalesce((attempt->>'attempt_count')::integer, 0), 0)
      ),
      collector_last_error = nullif(left(coalesce(attempt->>'last_error', ''), 240), ''),
      collector_reported_at = now(),
      collector_next_retry_at = case when next_retry_seconds > 0
        then now() + make_interval(secs => next_retry_seconds) else null end,
      source_latest_bar_time = coalesce(
        nullif(attempt->>'source_latest_bar_time', '')::timestamptz,
        source_latest_bar_time
      ),
      expected_bar_time = coalesce(
        nullif(attempt->>'expected_bar_time', '')::timestamptz,
        expected_bar_time
      ),
      last_attempt_at = now(),
      updated_at = now()
    where terminal_id = p_terminal_id
      and symbol = upper(btrim(attempt->>'symbol'))
      and timeframe = attempt->>'timeframe'
      and desired_enabled;
    get diagnostics changed = row_count;
    affected := affected + changed;
  end loop;
  return affected;
end;
$$;

revoke all on function public.record_price_feed_attempts(uuid,jsonb)
  from public, anon, authenticated;
grant execute on function public.record_price_feed_attempts(uuid,jsonb)
  to service_role;
