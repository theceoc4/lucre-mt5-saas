-- v1.0.37 -- Make one EA session authoritative per terminal and accept the
-- broker's complete available history when it is deep enough for EMA-200.

alter table public.mt5_terminals
  add column active_ea_instance_id text,
  add column active_ea_instance_seen_at timestamptz,
  add column active_ea_is_vps boolean,
  add column terminal_trade_allowed boolean,
  add column mql_trade_allowed boolean,
  add column account_trade_allowed boolean,
  add column account_expert_trade_allowed boolean,
  add column trade_capability_reported_at timestamptz;

comment on column public.mt5_terminals.active_ea_instance_id is
  'Opaque ID of the EA session currently holding the terminal ingestion/command lease.';
comment on column public.mt5_terminals.trade_capability_reported_at is
  'When the active EA last reported terminal, EA-property, account, and expert-trading capability flags.';

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
  affected integer;
begin
  if nullif(btrim(p_instance_id), '') is null then
    return false;
  end if;

  update public.mt5_terminals terminal set
    active_ea_instance_id = p_instance_id,
    active_ea_instance_seen_at = now(),
    active_ea_is_vps = coalesce(p_is_vps, false)
  where terminal.id = p_terminal_id
    and (
      terminal.active_ea_instance_id is null
      or terminal.active_ea_instance_id = p_instance_id
      or terminal.active_ea_instance_seen_at is null
      or terminal.active_ea_instance_seen_at < now() - make_interval(secs => least(greatest(p_lease_seconds, 15), 300))
      or (coalesce(p_is_vps, false) and not coalesce(terminal.active_ea_is_vps, false))
    );

  get diagnostics affected = row_count;
  return affected > 0;
end;
$$;

revoke all on function public.claim_terminal_ea_instance(uuid, text, boolean, integer)
  from public, anon, authenticated;
grant execute on function public.claim_terminal_ea_instance(uuid, text, boolean, integer)
  to service_role;

comment on function public.claim_terminal_ea_instance(uuid, text, boolean, integer) is
  'Atomically grants or renews one EA session lease. A VPS session preempts a local session; otherwise a second live EA remains standby until the active lease expires.';

-- 240 candles is enough to warm EMA-200 plus a safety buffer. Requiring 500
-- made XRPUSD W1 upload the broker's complete 485-week history every five
-- seconds forever. We still request and retain up to 1,000 whenever available.
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
      not (snapshot_complete and retained_count >= 240),
      case when snapshot_complete and retained_count >= 240 then now() else null end,
      case
        when snapshot_complete and retained_count >= 240 then 'live'
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
          and retained_count >= 240 then false
        else public.price_feed_series_state.bootstrap_required
      end,
      bootstrapped_at = case
        when snapshot_complete
          and generation = public.price_feed_series_state.bootstrap_generation
          and retained_count >= 240 then now()
        else public.price_feed_series_state.bootstrapped_at
      end,
      status = case
        when snapshot_complete
          and generation = public.price_feed_series_state.bootstrap_generation
          and retained_count >= 240 then 'live'
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

update public.price_feed_series_state set
  bootstrap_required = false,
  bootstrapped_at = coalesce(bootstrapped_at, now()),
  status = 'live',
  updated_at = now()
where desired_enabled
  and bootstrap_required
  and history_bar_count >= 240;
