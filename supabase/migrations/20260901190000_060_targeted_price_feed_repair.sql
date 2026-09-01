-- v1.0.38 -- Targeted candle-feed repair, visible repair lifecycle, and
-- immediate per-series retention.

alter table public.price_feed_series_state
  add column repair_requested_at timestamptz,
  add column repair_requested_by uuid,
  add column repair_reason text;

comment on column public.price_feed_series_state.repair_requested_at is
  'Most recent authenticated or automatic request for a clean broker snapshot.';

create or replace function public.request_price_feed_repair(
  p_terminal_id uuid,
  p_symbol text,
  p_timeframe text,
  p_requested_by uuid default null,
  p_reason text default 'manual'
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  current_state public.price_feed_series_state%rowtype;
  retry_after integer;
begin
  if p_timeframe not in ('M1','M5','M15','M30','H1','H4','D1','W1') then
    raise exception 'unsupported_timeframe';
  end if;

  select * into current_state
  from public.price_feed_series_state
  where terminal_id = p_terminal_id
    and symbol = upper(btrim(p_symbol))
    and timeframe = p_timeframe
  for update;

  if not found or not current_state.desired_enabled then
    return jsonb_build_object('status', 'series_not_enabled');
  end if;

  if current_state.repair_requested_at is not null
     and current_state.repair_requested_at > now() - interval '5 minutes' then
    retry_after := greatest(1, ceil(extract(epoch from (
      current_state.repair_requested_at + interval '5 minutes' - now()
    )))::integer);
    return jsonb_build_object(
      'status', 'already_requested',
      'retry_after_seconds', retry_after,
      'bootstrap_generation', current_state.bootstrap_generation
    );
  end if;

  update public.price_feed_series_state set
    bootstrap_generation = bootstrap_generation + 1,
    bootstrap_required = true,
    status = 'pending',
    last_error = null,
    repair_requested_at = now(),
    repair_requested_by = p_requested_by,
    repair_reason = left(coalesce(nullif(btrim(p_reason), ''), 'manual'), 40),
    updated_at = now()
  where terminal_id = p_terminal_id
    and symbol = upper(btrim(p_symbol))
    and timeframe = p_timeframe
  returning * into current_state;

  return jsonb_build_object(
    'status', 'requested',
    'symbol', current_state.symbol,
    'timeframe', current_state.timeframe,
    'bootstrap_generation', current_state.bootstrap_generation,
    'repair_requested_at', current_state.repair_requested_at
  );
end;
$$;

revoke all on function public.request_price_feed_repair(uuid,text,text,uuid,text)
  from public, anon, authenticated;
grant execute on function public.request_price_feed_repair(uuid,text,text,uuid,text)
  to service_role;

-- Keep the operational table at exactly the newest 1,000 rows for only the
-- series touched by the current request. This avoids a full-table ranking on
-- every minute-level ingest while retaining the hourly sweep as a safety net.
create or replace function public.prune_touched_price_bar_series(
  p_terminal_id uuid,
  p_series jsonb
) returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  removed integer;
begin
  if jsonb_typeof(p_series) is distinct from 'array' then
    raise exception 'p_series must be a JSON array';
  end if;

  with requested as (
    select distinct item.symbol, item.timeframe
    from jsonb_to_recordset(p_series) as item(symbol text, timeframe text)
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
  delete from public.price_bars bars
  using expired
  where bars.id = expired.id;

  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function public.prune_touched_price_bar_series(uuid,jsonb)
  from public, anon, authenticated;
grant execute on function public.prune_touched_price_bar_series(uuid,jsonb)
  to service_role;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'price_feed_series_state'
  ) then
    alter publication supabase_realtime add table public.price_feed_series_state;
  end if;
end $$;
