-- v1.0.39 -- Idempotent candle repair requests and durable EA collector health.

alter table public.price_feed_series_state
  add column collector_state text not null default 'idle'
    check (collector_state in (
      'idle','sync_requested','waiting_history','ready','uploading','retry_backoff','error'
    )),
  add column collector_attempt_count integer not null default 0
    check (collector_attempt_count >= 0),
  add column collector_last_error text,
  add column collector_reported_at timestamptz,
  add column collector_next_retry_at timestamptz,
  add column source_latest_bar_time timestamptz,
  add column last_upload_status integer,
  add column last_success_at timestamptz;

comment on column public.price_feed_series_state.collector_state is
  'The EA-side MT5 history synchronization state most recently reported for this series.';
comment on column public.price_feed_series_state.source_latest_bar_time is
  'Newest closed broker candle visible to the EA, which can differ from the durable Supabase checkpoint while MT5 history is synchronizing.';

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
  request_status text;
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

  -- A repair generation is a stable job identity. Repeated dashboard clicks or
  -- automatic stale checks wake the existing job without invalidating a clean
  -- snapshot that may already be in flight from the VPS.
  if current_state.bootstrap_required then
    request_status := 'resumed';
    update public.price_feed_series_state set
      status = 'pending',
      last_error = null,
      repair_requested_at = now(),
      repair_requested_by = coalesce(p_requested_by, repair_requested_by),
      repair_reason = left(coalesce(nullif(btrim(p_reason), ''), 'manual'), 40),
      collector_state = 'sync_requested',
      collector_last_error = null,
      collector_next_retry_at = null,
      updated_at = now()
    where terminal_id = p_terminal_id
      and symbol = upper(btrim(p_symbol))
      and timeframe = p_timeframe
    returning * into current_state;
  else
    request_status := 'requested';
    update public.price_feed_series_state set
      bootstrap_generation = bootstrap_generation + 1,
      bootstrap_required = true,
      status = 'pending',
      last_error = null,
      repair_requested_at = now(),
      repair_requested_by = p_requested_by,
      repair_reason = left(coalesce(nullif(btrim(p_reason), ''), 'manual'), 40),
      collector_state = 'sync_requested',
      collector_attempt_count = 0,
      collector_last_error = null,
      collector_next_retry_at = null,
      updated_at = now()
    where terminal_id = p_terminal_id
      and symbol = upper(btrim(p_symbol))
      and timeframe = p_timeframe
    returning * into current_state;
  end if;

  return jsonb_build_object(
    'status', request_status,
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
      'idle','sync_requested','waiting_history','ready','uploading','retry_backoff','error'
    ) then
      continue;
    end if;
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
