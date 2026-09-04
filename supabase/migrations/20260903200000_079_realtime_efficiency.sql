-- v1.0.56 -- Compact private market-state broadcasts and quiet lease renewal.
--
-- Candle rows and their durable checkpoints remain unchanged. The dashboard
-- now receives one owner-only market_state event per accepted report-bars
-- request instead of one Postgres Changes message per changed series row.

create or replace function public.broadcast_private_terminal_event(
  p_terminal_id uuid,
  p_event text,
  p_payload jsonb
)
returns void
language plpgsql
security definer
set search_path = public, realtime, pg_temp
as $$
declare
  topic_id uuid;
begin
  if p_event not in ('market_state') then
    raise exception using errcode = '22023', message = 'invalid_private_terminal_event';
  end if;
  if jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'invalid_private_terminal_payload';
  end if;

  select terminal.realtime_topic_id
    into topic_id
    from public.mt5_terminals terminal
   where terminal.id = p_terminal_id;

  if topic_id is null then
    raise exception using errcode = 'P0002', message = 'terminal_not_found';
  end if;

  perform realtime.send(
    p_payload,
    p_event,
    'terminal:' || topic_id::text || ':positions',
    true
  );
end;
$$;

revoke all on function public.broadcast_private_terminal_event(uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.broadcast_private_terminal_event(uuid, text, jsonb)
  to service_role;

comment on function public.broadcast_private_terminal_event(uuid, text, jsonb) is
  'Server-only relay for compact owner-scoped terminal events. Event names are allowlisted.';

-- These high-churn tables now travel as one compact private batch. Removing
-- them from the publication does not remove data, RLS, retention, or reads.
do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'price_feed_series_state'
  ) then
    alter publication supabase_realtime drop table public.price_feed_series_state;
  end if;
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'symbol_trend_state'
  ) then
    alter publication supabase_realtime drop table public.symbol_trend_state;
  end if;
end $$;

-- A healthy EA may use the command-only safety lane every second while its
-- WebSocket reconnects. The same lease holder is still accepted immediately,
-- but its durable lease timestamp is refreshed at most every 15 seconds.
create or replace function public.claim_terminal_ea_instance(
  p_terminal_id uuid,
  p_instance_id text,
  p_is_vps boolean default false,
  p_lease_seconds integer default 45
) returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  current_instance text;
  current_seen timestamptz;
  current_is_vps boolean;
  lease_window interval;
begin
  if nullif(btrim(p_instance_id), '') is null then return false; end if;
  lease_window := make_interval(secs => least(greatest(p_lease_seconds, 15), 300));

  select active_ea_instance_id, active_ea_instance_seen_at, active_ea_is_vps
    into current_instance, current_seen, current_is_vps
    from public.mt5_terminals
   where id = p_terminal_id
   for update;
  if not found then return false; end if;

  if current_instance = p_instance_id then
    if current_seen is null or current_seen < now() - interval '15 seconds' then
      update public.mt5_terminals set
        active_ea_instance_seen_at = now(),
        active_ea_is_vps = coalesce(p_is_vps, false)
      where id = p_terminal_id;
    end if;
    return true;
  end if;

  if current_instance is not null
     and current_seen is not null
     and current_seen >= now() - lease_window
     and not (coalesce(p_is_vps, false) and not coalesce(current_is_vps, false)) then
    return false;
  end if;

  update public.mt5_terminals set
    active_ea_instance_id = p_instance_id,
    active_ea_instance_seen_at = now(),
    active_ea_is_vps = coalesce(p_is_vps, false)
  where id = p_terminal_id;
  return true;
end;
$$;

revoke all on function public.claim_terminal_ea_instance(uuid, text, boolean, integer)
  from public, anon, authenticated;
grant execute on function public.claim_terminal_ea_instance(uuid, text, boolean, integer)
  to service_role;

comment on function public.claim_terminal_ea_instance(uuid, text, boolean, integer) is
  'Grants one authoritative EA lease while throttling same-holder durable writes to one per 15 seconds.';

-- Repeated identical broker-wait diagnostics are useful as liveness evidence,
-- but persisting them every second adds no information. Store state changes
-- immediately and otherwise refresh the evidence no more than twice a minute.
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
  next_attempt_count integer;
  next_error text;
  next_source_latest timestamptz;
  next_source_tick timestamptz;
  next_expected timestamptz;
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
    next_attempt_count := greatest(coalesce((attempt->>'attempt_count')::integer, 0), 0);
    next_error := nullif(left(coalesce(attempt->>'last_error', ''), 240), '');
    next_source_latest := nullif(attempt->>'source_latest_bar_time', '')::timestamptz;
    next_source_tick := nullif(attempt->>'source_tick_time', '')::timestamptz;
    next_expected := nullif(attempt->>'expected_bar_time', '')::timestamptz;

    update public.price_feed_series_state state set
      collector_state = next_state,
      collector_attempt_count = case
        when next_state in ('idle','ready','market_closed') then 0
        else greatest(state.collector_attempt_count, next_attempt_count)
      end,
      collector_last_error = next_error,
      collector_reported_at = now(),
      collector_next_retry_at = case when next_retry_seconds > 0
        then now() + make_interval(secs => next_retry_seconds) else null end,
      source_latest_bar_time = coalesce(next_source_latest, state.source_latest_bar_time),
      source_tick_time = coalesce(next_source_tick, state.source_tick_time),
      expected_bar_time = next_expected,
      last_attempt_at = now(),
      updated_at = now()
    where state.terminal_id = p_terminal_id
      and state.symbol = upper(btrim(attempt->>'symbol'))
      and state.timeframe = attempt->>'timeframe'
      and state.desired_enabled
      and (
        state.collector_state is distinct from next_state
        or state.collector_last_error is distinct from next_error
        or state.source_latest_bar_time is distinct from coalesce(next_source_latest, state.source_latest_bar_time)
        or state.expected_bar_time is distinct from next_expected
        or state.collector_reported_at is null
        or state.collector_reported_at < now() - interval '30 seconds'
      );
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
  'Records changed collector evidence immediately and throttles identical liveness-only writes to 30 seconds.';
