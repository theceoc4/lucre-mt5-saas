-- v1.0.35 -- Explicit lifecycle for every enabled broker candle series.
--
-- A latest-candle checkpoint prevents duplicate restart replays, but it does
-- not prove that the retained history is complete. This migration turns the
-- checkpoint row into a small manifest: desired collection state, bootstrap
-- generation, verified history depth, and operational health.

alter table public.price_feed_series_state
  alter column latest_bar_time drop not null,
  add column oldest_bar_time timestamptz,
  add column history_bar_count integer not null default 0
    check (history_bar_count between 0 and 1000),
  add column desired_enabled boolean not null default true,
  add column priority_rank integer not null default 99
    check (priority_rank between 0 and 99),
  add column bootstrap_generation integer not null default 1
    check (bootstrap_generation > 0),
  add column bootstrap_required boolean not null default true,
  add column bootstrapped_at timestamptz,
  add column status text not null default 'pending'
    check (status in ('pending','bootstrapping','live','incomplete','error','disabled')),
  add column last_error text,
  add column last_attempt_at timestamptz;

-- Establish exact retained depth from the existing bounded cache, then require
-- one clean snapshot under the new generation so gaps hidden by a count of
-- 1,000 are repaired rather than grandfathered in.
with history as (
  select terminal_id, symbol, timeframe,
    count(*)::integer bar_count,
    min(bar_time) oldest_bar_time,
    max(bar_time) latest_bar_time
  from public.price_bars
  group by terminal_id, symbol, timeframe
)
update public.price_feed_series_state state set
  oldest_bar_time = history.oldest_bar_time,
  latest_bar_time = history.latest_bar_time,
  history_bar_count = least(history.bar_count, 1000),
  bootstrap_generation = state.bootstrap_generation + 1,
  bootstrap_required = true,
  status = 'pending',
  updated_at = now()
from history
where history.terminal_id = state.terminal_id
  and history.symbol = state.symbol
  and history.timeframe = state.timeframe;

-- Reconciles the server manifest with the current mappings/settings/strategy
-- priorities. It is safe to call on every ea-sync: unchanged rows are not
-- updated, while disabled -> enabled is treated as a new clean bootstrap.
create or replace function public.reconcile_price_feed_manifest(
  p_terminal_id uuid,
  p_desired jsonb
) returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  desired record;
begin
  if jsonb_typeof(p_desired) is distinct from 'array' then
    raise exception 'p_desired must be a JSON array';
  end if;

  for desired in
    select * from jsonb_to_recordset(p_desired) as item(
      symbol text,
      timeframe text,
      enabled boolean,
      priority_rank integer
    )
  loop
    insert into public.price_feed_series_state (
      terminal_id, symbol, timeframe, latest_bar_time, desired_enabled,
      priority_rank, bootstrap_generation, bootstrap_required, status,
      last_received_at, updated_at
    ) values (
      p_terminal_id, desired.symbol, desired.timeframe, null,
      coalesce(desired.enabled, false),
      least(greatest(coalesce(desired.priority_rank, 99), 0), 99),
      1, coalesce(desired.enabled, false),
      case when coalesce(desired.enabled, false) then 'pending' else 'disabled' end,
      now(), now()
    )
    on conflict (terminal_id, symbol, timeframe) do update set
      bootstrap_generation = case
        when not public.price_feed_series_state.desired_enabled
          and coalesce(desired.enabled, false)
        then public.price_feed_series_state.bootstrap_generation + 1
        else public.price_feed_series_state.bootstrap_generation
      end,
      bootstrap_required = case
        when not public.price_feed_series_state.desired_enabled
          and coalesce(desired.enabled, false) then true
        else public.price_feed_series_state.bootstrap_required
      end,
      status = case
        when not coalesce(desired.enabled, false) then 'disabled'
        when not public.price_feed_series_state.desired_enabled then 'pending'
        else public.price_feed_series_state.status
      end,
      desired_enabled = coalesce(desired.enabled, false),
      priority_rank = least(greatest(coalesce(desired.priority_rank, 99), 0), 99),
      updated_at = now()
    where public.price_feed_series_state.desired_enabled is distinct from coalesce(desired.enabled, false)
       or public.price_feed_series_state.priority_rank is distinct from
          least(greatest(coalesce(desired.priority_rank, 99), 0), 99);
  end loop;
end;
$$;

revoke all on function public.reconcile_price_feed_manifest(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.reconcile_price_feed_manifest(uuid, jsonb)
  to service_role;

-- Record accepted batches and verify snapshot depth only for explicit clean
-- snapshots. Normal one-candle updates remain a single compact state update;
-- they do not rescan the retained history table.
create or replace function public.record_price_feed_batches(
  p_terminal_id uuid,
  p_batches jsonb
) returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  batch jsonb;
  batch_count integer;
  generation integer;
  snapshot_complete boolean;
  retained_count integer;
  retained_oldest timestamptz;
  retained_latest timestamptz;
begin
  if jsonb_typeof(p_batches) is distinct from 'array' then
    raise exception 'p_batches must be a JSON array';
  end if;

  for batch in select value from jsonb_array_elements(p_batches)
  loop
    batch_count := least(greatest(coalesce((batch->>'bar_count')::integer, 0), 0), 1000);
    generation := greatest(coalesce((batch->>'bootstrap_generation')::integer, 0), 0);
    snapshot_complete := coalesce((batch->>'snapshot_complete')::boolean, false);

    if snapshot_complete then
      select count(*)::integer, min(bar_time), max(bar_time)
      into retained_count, retained_oldest, retained_latest
      from public.price_bars
      where terminal_id = p_terminal_id
        and symbol = batch->>'symbol'
        and timeframe = batch->>'timeframe';
      retained_count := least(coalesce(retained_count, 0), 1000);
    end if;

    insert into public.price_feed_series_state (
      terminal_id, symbol, timeframe, latest_bar_time, oldest_bar_time,
      history_bar_count, last_received_at, last_batch_bar_count,
      bootstrap_generation, bootstrap_required, bootstrapped_at, status,
      last_attempt_at, updated_at
    ) values (
      p_terminal_id,
      batch->>'symbol',
      batch->>'timeframe',
      (batch->>'latest_bar_time')::timestamptz,
      case when snapshot_complete then retained_oldest else null end,
      case when snapshot_complete then retained_count else 0 end,
      now(), batch_count,
      greatest(generation, 1),
      not (snapshot_complete and retained_count >= 500),
      case when snapshot_complete and retained_count >= 500 then now() else null end,
      case
        when snapshot_complete and retained_count >= 500 then 'live'
        when snapshot_complete then 'incomplete'
        else 'pending'
      end,
      now(), now()
    )
    on conflict (terminal_id, symbol, timeframe) do update set
      latest_bar_time = greatest(
        public.price_feed_series_state.latest_bar_time,
        excluded.latest_bar_time
      ),
      oldest_bar_time = case when snapshot_complete then retained_oldest
        else public.price_feed_series_state.oldest_bar_time end,
      history_bar_count = case when snapshot_complete then retained_count
        else public.price_feed_series_state.history_bar_count end,
      last_received_at = now(),
      last_batch_bar_count = batch_count,
      bootstrap_required = case
        when snapshot_complete
          and generation = public.price_feed_series_state.bootstrap_generation
          and retained_count >= 500 then false
        else public.price_feed_series_state.bootstrap_required
      end,
      bootstrapped_at = case
        when snapshot_complete
          and generation = public.price_feed_series_state.bootstrap_generation
          and retained_count >= 500 then now()
        else public.price_feed_series_state.bootstrapped_at
      end,
      status = case
        when snapshot_complete
          and generation = public.price_feed_series_state.bootstrap_generation
          and retained_count >= 500 then 'live'
        when snapshot_complete
          and generation = public.price_feed_series_state.bootstrap_generation then 'incomplete'
        when public.price_feed_series_state.bootstrap_required then 'bootstrapping'
        else 'live'
      end,
      last_error = null,
      last_attempt_at = now(),
      updated_at = now();
  end loop;
end;
$$;

revoke all on function public.record_price_feed_batches(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_price_feed_batches(uuid, jsonb)
  to service_role;

comment on function public.reconcile_price_feed_manifest(uuid, jsonb) is
  'Idempotently reconciles enabled mappings/timeframes and strategy priority. Re-enabling a series creates a new clean-bootstrap generation.';
