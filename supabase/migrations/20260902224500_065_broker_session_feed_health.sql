-- v1.0.43 -- Preserve broker-session truth without synthesizing candles.

alter table public.strategy_evaluation_state
  drop constraint if exists strategy_evaluation_state_status_check;

alter table public.strategy_evaluation_state
  add constraint strategy_evaluation_state_status_check
  check (status in (
    'disabled','session_blocked','symbol_disabled','missing_bars','stale_candles',
    'market_paused','no_setup','direction_blocked','spread_blocked','cooldown_blocked',
    'duplicate_bar','shadow_signal','manual_signal','ea_version_blocked','policy_blocked',
    'risk_blocked','broker_mapping_failed','command_failed','command_queued'
  ));

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
  next_state text;
begin
  if jsonb_typeof(p_attempts) is distinct from 'array' then
    raise exception 'p_attempts must be a JSON array';
  end if;
  for attempt in select value from jsonb_array_elements(p_attempts)
  loop
    next_state := coalesce(attempt->>'state', '');
    if next_state not in (
      'idle','sync_requested','waiting_history','awaiting_tick','ready',
      'upload_pending','uploading','retry_backoff','market_closed','error'
    ) then continue; end if;
    next_retry_seconds := greatest(coalesce((attempt->>'retry_after_seconds')::integer, 0), 0);
    update public.price_feed_series_state set
      collector_state = next_state,
      collector_attempt_count = case
        when next_state in ('idle','ready','market_closed') then 0
        else greatest(
          collector_attempt_count,
          greatest(coalesce((attempt->>'attempt_count')::integer, 0), 0)
        )
      end,
      collector_last_error = nullif(left(coalesce(attempt->>'last_error', ''), 240), ''),
      collector_reported_at = now(),
      collector_next_retry_at = case when next_retry_seconds > 0
        then now() + make_interval(secs => next_retry_seconds) else null end,
      source_latest_bar_time = coalesce(
        nullif(attempt->>'source_latest_bar_time', '')::timestamptz,
        source_latest_bar_time
      ),
      source_tick_time = coalesce(
        nullif(attempt->>'source_tick_time', '')::timestamptz,
        source_tick_time
      ),
      expected_bar_time = nullif(attempt->>'expected_bar_time', '')::timestamptz,
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

comment on function public.record_price_feed_attempts(uuid,jsonb) is
  'Records broker candle collection evidence, including session pauses, source ticks, and the next real close expected after a session gap.';
